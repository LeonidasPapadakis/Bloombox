import datetime
import serial
import serial.tools.list_ports
import sqlite3
import subprocess

# Open a connection to the bloombox database with WAL mode enabled
def connectDB() -> sqlite3.Connection:
    connection = sqlite3.connect('bloombox.db', timeout=10)
    connection.execute('PRAGMA journal_mode=WAL')
    return connection

# Create tables for configuration, watering schedule and sensor data in sqlite database
def createTables() -> None:

    # Connect to database
    connection = connectDB()
    cursor = connection.cursor()

    # Try to create tables
    try:
        cursor.execute("CREATE TABLE IF NOT EXISTS piConfig (setting TEXT PRIMARY KEY, value TEXT, PRIMARY KEY (setting))")
        cursor.execute("CREATE TABLE IF NOT EXISTS arduinoConfig (setting TEXT, systemId INTEGER, value TEXT, PRIMARY KEY (setting, systemId))")
        cursor.execute("CREATE TABLE IF NOT EXISTS waterSchedule (time TEXT, systemId INTEGER, amount INTEGER, PRIMARY KEY (time, systemId))")
        cursor.execute("CREATE TABLE IF NOT EXISTS sensorData (timeStamp TEXT, systemId INTEGER, sensorType TEXT, sensorValue FLOAT)")
        cursor.execute("CREATE TABLE IF NOT EXISTS logs (timeStamp TEXT, log TEXT)")
    except sqlite3.OperationalError as e:
        print("Database table creation failed:", e)

    connection.commit()
    connection.close()

# Add a log entry to the database
def addLog(timeStamp : datetime.datetime, log : str) -> None:

    # Connect to database
    connection = connectDB()
    cursor = connection.cursor()

    # Try to insert log
    try:
        cursor.execute("INSERT INTO logs(timeStamp, log) VALUES (?, ?)",
            (str(timeStamp), log))
    except sqlite3.OperationalError as e:
        print("Log insertion failed:", e)
        
    connection.commit()
    connection.close()

# Read pi configuration from database
def updatePiConfig(config : dict) -> dict:

    # Connect to database
    connection = connectDB()
    cursor = connection.cursor()

    # Try to read configuration
    try:
        cursor.execute("SELECT * FROM piConfig")
    except sqlite3.OperationalError as e:
        print("Configuration read failed:", e)

    # Track which settings are seen in the table so we can add any that are missing
    seenSettings = []

    # Loop through rows in configuration table and update dictionary
    for setting, value in cursor:
        seenSettings.append(setting)

        # Convert text from db into required data 1type
        if setting == "manualTime":
            try:
                config[setting] = parseTime(value)
            except ValueError:
                print("Invalid time format (expected HH:MM):", value)
        elif setting == "updateInterval":
            try:
                config[setting] = int(value)
            except ValueError:
                print("Invalid update interval format (expected integer):", value)
        elif setting == "clockMode":
            if value in ("auto", "manual"):
                config[setting] = value
            else:
                print("Invalid clock mode (expected auto or manual):", value)
        elif setting != "dayTime" and setting != "nightTime" and setting != "wifiSSID" and setting != "wifiPassword":
            print("Unknown configuration setting:", setting)

    # Add any missing settings to table
    for setting in config.keys():
        if setting not in seenSettings:
            cursor.execute(f"INSERT INTO piConfig(setting, value) VALUES ('{setting}', '{config[setting]}')")
    
    connection.commit()
    connection.close()
    return config

# Read arduino configuration from database and update arduino if necessary
def updateArduinoConfig(ser : serial.Serial, currentConfig : dict) -> dict:
    
    # Connect to database
    connection = connectDB()
    cursor = connection.cursor()

    # Try to read system counts
    try:
        cursor.execute("SELECT setting, value FROM arduinoConfig WHERE setting = 'systemCount'")
    except sqlite3.OperationalError as e:
        print("Configuration read failed:", e)
    systemCount = 1
    for setting, value in cursor:
        systemCount = int(value)

    # Try to read configuration
    try:
        cursor.execute("SELECT * FROM arduinoConfig")
    except sqlite3.OperationalError as e:
        print("Arduino configuration read failed:", e)

    # Settings stored per-system for the dashboard but not understood by the Arduino
    skipSerial = {"dayTime", "nightTime"}

    # Loop through rows in configuration table and build new dictionary
    newConfig = {}
    for setting, systemId, value in cursor:

        if (setting == 'targetHumidity' or setting == 'targetLight') \
            and systemId < 1 and systemId > systemCount:
            continue

        newConfig[(setting, systemId)] = value

        # Skip settings that are per-system in the DB but only used by the dashboard
        if setting in skipSerial:
            continue

        # Only send command if value has changed
        if currentConfig.get((setting, systemId)) != value:
            command = f"{setting}{' ' + str(systemId) if systemId != 0 else ''} {value}" # Add system id if it is not 0 (0 is global)
            writeSerial(ser, command)

    # If any configurations are missing, add them to newConfig from currentConfig and send across serial
    for key in currentConfig.keys():
        if key not in newConfig.keys():
            newConfig[key] = currentConfig[key]

    connection.close()
    return newConfig

# Read watering schedule from database
def updateSchedule(schedule : dict) -> list:

    # Connect to database
    connection = connectDB()
    cursor = connection.cursor()

    # Try to read schedule
    try:
        cursor.execute("SELECT * FROM waterSchedule")
    except sqlite3.OperationalError as e:
        print("Schedule read failed:", e)

    # Track which events are seen in the table so we can tell which have been deleted
    seenKeys = []

    # Loop through rows in schedule table and update dictionary
    for row in cursor:
        
        # Parse columns from row
        timeString, systemId, amount = row
        try:
             time = parseTime(timeString)
        except ValueError:
            print("Invalid time format (expected HH:MM):", timeString)
            continue

        # Add to seen keys
        seenKeys.append((time, systemId))

        # Create new dictionary if event is new, initialise completed as false
        if (time, systemId) not in schedule.keys():
            schedule[(time, systemId)] = {"completed" : False}

        # Update amount
        schedule[(time, systemId)]["amount"] = amount

    connection.close()

    # Remove unseen schedule events
    for key in schedule.keys():
        if key not in seenKeys:
            schedule[key] = {}
        
    return schedule

# Delete sensor data older than 48 hours
def pruneSensorData() -> None:

    # Connect to database
    connection = connectDB()
    cursor = connection.cursor()

    # timeStamp is stored as 'YYYY-MM-DD HH:MM:SS'
    cutoff = datetime.datetime.now() - datetime.timedelta(hours=48)
    try:
        cursor.execute("DELETE FROM sensorData WHERE timeStamp < ?", (str(cutoff),))
    except sqlite3.OperationalError as e:
        print("Sensor data prune failed:", e)

    connection.commit()
    connection.close()

# Write sensor data to database
def writeSensorData(readings : list) -> None:

    # Connect to database
    connection = connectDB()
    cursor = connection.cursor()

    # Loop through sensor data
    for reading in readings:
        timeStamp, systemId, sensorType, sensorValue = reading

        # Try to insert event
        try:
            cursor.execute("INSERT INTO sensorData(timeStamp, systemId, sensorType, sensorValue) VALUES (?, ?, ?, ?)",
                (str(timeStamp), systemId, sensorType, sensorValue))
        except sqlite3.OperationalError as e:
            print("Sensor data insertion failed:", e)
        
    connection.commit()
    connection.close()

# Find the serial port connected to the arduino
def findArduino() -> serial.Serial:

    print("Searching for arduino...")

    # Loop until arduino is found
    ser = None
    while ser == None:

        # Loop through all serial ports
        for port in serial.tools.list_ports.comports():

            # Check if the port is connected to the arduino
            if port.description == "Arduino Leonardo":

                # Try to open serial port
                try:
                    ser = serial.Serial(port.device, 9600, timeout=1)
                    print(f"Found arduino on {port.device}")
                
                except serial.SerialException as e:
                    continue
    return ser
    

# Write data to serial
def writeSerial(ser : serial.Serial, data : str) -> None:
    ser.write(bytes(data + '\n', 'utf-8'))

# Read data from serial
def readSerial(ser : serial.Serial) -> str:
    
    # Loop until data is read
    validRead = False
    while not validRead:
        
        # Try to read data from serial
        try:
            if ser.in_waiting > 0:
                serialData = ser.readline().decode('utf-8')[:-1].strip()
            else:
                serialData = None
            validRead = True

        # If read failed, search for arduino again
        except serial.SerialException as e:
            print(f"Serial connection lost: {e}")
            ser = findArduino()
        except OSError as e:
            print(f"Serial connection lost: {e}")
            ser = findArduino()
        
    return serialData

# Parse a time from a string
def parseTime(timeString : str):
    return datetime.datetime.strptime(timeString, "%H:%M").time()

# Apply system clock changes with timedatectl.
def applySystemClock(clockMode, manualTime):
    """
    try:
        if clockMode == "manual" and isinstance(manualTime, datetime.time):
            subprocess.run(["sudo", "timedatectl", "set-ntp", "false"], check=True)
            today = datetime.date.today().isoformat()
            timeStr = manualTime.strftime("%H:%M:%S")
            subprocess.run(["sudo", "timedatectl", "set-time", f"{today} {timeStr}"], check=True)
            print(f"System clock set manually to {today} {timeStr}")
        else:
            subprocess.run(["sudo", "timedatectl", "set-ntp", "true"], check=True)
            print("System clock set to auto (NTP)")
        return True
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"Failed to update system clock: {e}")
        return False
"""
# Main loop
def main():
    # Create database tables if they don't already exist
    createTables()

    # Find serial connection
    ser = findArduino()

    # Flags
    isReading = False # True if currently reading sensor data
    nightMode = False # True if currently in night mode

    # Pi configuration dictionary, mapping setting to value
    piConfig = {
        "updateInterval" : 100,
        "clockMode" : "auto",
        "manualTime" : datetime.time(12, 0)
        }

    # Track the last clock state we successfully applied so we only re-apply on change
    appliedClockMode = None
    appliedManualTime = None

    # Arduino configuration dictionary, key is a tuple of (setting, system id) - system id is 0 if setting is global e.g. readingInterval
    arduinoConfig = {
        ("systemCount", 0) : 1,
        ("readingInterval", 0) : 60,
        ("lightInterval", 0) : 50,
        ("ventInterval", 0) : 5000
    }
    # Default target values
    for systemId in range(1, arduinoConfig[("systemCount", 0)] + 1):
        arduinoConfig[("targetHumidity", systemId)] = 100
    for systemId in range(1, arduinoConfig[("systemCount", 0)] + 1):
        arduinoConfig[("targetLight", systemId)] = 50

    # Per-system day/night windows.
    for systemId in range(1, arduinoConfig[("systemCount", 0)] + 1):
        arduinoConfig[("dayTime", systemId)] = "08:00"
        arduinoConfig[("nightTime", systemId)] = "20:00"

    # Schedule dictionary of water events, key is a tuple of (time, system id)
    waterSchedule = {}

    # Read configuration from database
    piConfig = updatePiConfig(piConfig)
    arduinoConfig = updateArduinoConfig(ser, arduinoConfig)
    waterSchedule = updateSchedule(waterSchedule)

    readings = []

    # Update configuration and schedule dictionaries from database at set intervals
    nextUpdate = datetime.datetime.now()

    # Loop forver
    while True:
            
        # Read data from serial
        serialData = readSerial(ser)

        # Get current date and time
        currentDateTime = datetime.datetime.now()
        currentTime = currentDateTime.time()

        # Check if data was read
        if serialData != None:

            # Print 'timestamp -> serial data' to console for debugging
            print(f"{currentTime.replace(microsecond=0)} -> {serialData}")

            # Add serial data to logs
            addLog(currentDateTime.replace(microsecond=0), serialData)

            # Check for start and end of sensor reads
            if serialData == "READING SENSORS":
                isReading = True
                continue
            elif serialData == "FINISHED READING SENSORS":
                isReading = False

                # Write sensor data to database table
                writeSensorData(readings)
                readings = []
        
            # Read sensor data
            if isReading:
                sensorReading = serialData.split(" ")

                # Parse sensor data
                try:

                    # Check if sensor data is valid
                    if len(sensorReading) < 3:
                        raise ValueError
                    
                    systemId = int(sensorReading[0])
                    sensorType = sensorReading[1]
                    sensorValue = float(sensorReading[2])
                    
                    # Check if sensor value is valid
                    if sensorValue == -1.0:
                        continue

                    # Add sensor reading to list (ignore microseconds in timestamp)
                    readings.append((currentDateTime.replace(microsecond=0), systemId, sensorType, sensorValue))

                # Handle invalid sensor data
                except ValueError:
                    print(f"Invalid format for sensor data ({serialData}), expected: [integer string float]")
        
                continue

        # Update configuration and schedule if next update time has passed
        if currentDateTime >= nextUpdate:
            nextUpdate = currentDateTime + datetime.timedelta(milliseconds = piConfig["updateInterval"])
            piConfig = updatePiConfig(piConfig)
            arduinoConfig = updateArduinoConfig(ser, arduinoConfig)
            waterSchedule = updateSchedule(waterSchedule)
            pruneSensorData()

            # Apply system clock changes only when the user has changed clockMode or set a new manualTime while in manual mode
            clockMode = piConfig.get("clockMode", "auto")
            manualTime = piConfig.get("manualTime")
            if clockMode != appliedClockMode or (clockMode == "manual" and manualTime != appliedManualTime):
                if applySystemClock(clockMode, manualTime):
                    appliedClockMode = clockMode
                    appliedManualTime = manualTime
                    nextUpdate = datetime.datetime.now()

        # Activate or deactivate night mode if time has passed.
        # Per-system day/night windows live in arduinoConfig for the dashboard, but
        # the Arduino only gets a single universal flag, system 1 is the source.
        try:
            dayTime = parseTime(arduinoConfig.get(("dayTime", 1), "08:00"))
        except ValueError:
            dayTime = datetime.time(8, 0)
        try:
            nightTime = parseTime(arduinoConfig.get(("nightTime", 1), "20:00"))
        except ValueError:
            nightTime = datetime.time(20, 0)

        # Determine if it is day or night
        if dayTime < nightTime:
            isDay = dayTime <= currentTime < nightTime
        else:
            isDay = currentTime >= dayTime or currentTime < nightTime

        # Activate day/night mode
        if not isDay and not nightMode:
            writeSerial(ser, "night")
            nightMode = True
        elif isDay and nightMode:
            writeSerial(ser, "day")
            nightMode = False

        # Check events in water schedule
        for key in list(waterSchedule.keys()):

            # Skip deleted events
            if not waterSchedule[key]:
                continue

            eventTime = key[0]
            systemId = key[1]
            amount = waterSchedule[key]["amount"]

            # Check if time has passed and event has not been completed
            if currentTime >= eventTime and not waterSchedule[key]["completed"]:

                # Send water command to serial and mark event as completed
                writeSerial(ser, f"water {systemId} {amount}")
                waterSchedule[key]["completed"] = True

if __name__ == "__main__":
    main()
