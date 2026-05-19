#include <Servo.h>
#include <DHT.h>
#include <rgb_lcd.h>

#define DHTTYPE DHT11

// Count of seperate systems (given by python script)
int systemCount = 1;

// The open/closed positions for water and air vent servos
const int WATER_CLOSED_POSITION = 90;
const int WATER_OPEN_POSITION = 180;
const int VENT_CLOSED_POSITION = 30;
const int VENT_OPEN_POSITION = 117;

// SENSOR / ACTUATOR PINS - Arrays allow for multiple device sets to be added for different areas (array sizes must be equal)
const int TEMP_HUMIDITY_SENSOR_PINS[] = {7, -1, -1};
const int VENT_SERVO_PINS[] = {5, -1, -1};
const int WATER_SERVO_PINS[] = {4, -1, -1};
const int LIGHT_SENSOR_PINS[] = {A0, -1, -1};
const int LED_PINS[] = {6, -1, -1};

// Maximum count of devices
const int MAX_SYSTEM_COUNT = sizeof(LED_PINS) / sizeof(int);

// Night mode status -> false = day, true = night
bool nightMode = false;

// Modes for light and ventilation control (auto/manual)
char* lightMode[MAX_SYSTEM_COUNT] = {"manual"};
char* ventMode[MAX_SYSTEM_COUNT] = {"manual"};

// Target levels
int targetLightLevel[MAX_SYSTEM_COUNT] = {600};
int targetHumidity[MAX_SYSTEM_COUNT] = {50};

// Manual settings
int ventManual[MAX_SYSTEM_COUNT] = {0};
int lightManual[MAX_SYSTEM_COUNT] = {0};

// Interval for calling certain methods (milliseconds)
int readingInterval = 10000; // Interval for sending sensor readings across serial
int ventInterval = 5000; // Interval for adjusting ventilation based on humidity readings
int lightInterval = 50; // Interval for adjusting lighting based on light sensor readings

// Track time when certain methods were called last
unsigned long lastReadingTime = 0;
unsigned long lastVentTime = 0;
unsigned long lastLightTime = 0;

// Track actuator status
int currentLEDbrightness[MAX_SYSTEM_COUNT] = {0};
int previousLEDbrightness[MAX_SYSTEM_COUNT] = {0};
unsigned long lastLEDupdate[MAX_SYSTEM_COUNT] = {0};
float currentVentPosition[MAX_SYSTEM_COUNT] = {0.0};

// Watering timer statuses -> an array of end times in milliseconds for watering, 0 = not watering
unsigned long wateringTimers[MAX_SYSTEM_COUNT] = {0};

// Most recent sensor readings to display on LCD
float lastLightReadings[MAX_SYSTEM_COUNT] = {0.0};
float lastTempReadings[MAX_SYSTEM_COUNT] = {0.0};
float lastHumidityReadings[MAX_SYSTEM_COUNT] = {0.0};

// Track settings for LCD display
char* systemNames[] = {"System 1", "System 2", "System 3"}; 
int displaySystem = 0; // Current system being displayed
char displayReading = 'T'; // Current reading being displayed
unsigned long lastDisplayUpdate = 0; // Last time display was updated
unsigned long lastDisplaySwitch = 0; // Last time system was switched
const int DISPLAY_UPDATE_INTERVAL = 1000; // ms between display updates
const int DISPLAY_SWITCH_INTERVAL = 3000; // ms per system
const byte degreeSymbol[8] = {
    0b00111,
    0b00101,
    0b00111,
    0b00000,
    0b00000,
    0b00000,
    0b00000,
    0b00000
};
const byte moonSymbol[8] = {
    0b01111,
    0b11100,
    0b11000,
    0b11000,
    0b11000,
    0b11000,
    0b11100,
    0b01111
};

// LCD screen object
rgb_lcd lcd;

// Create servo objects for water and air vent servos
Servo waterServos[MAX_SYSTEM_COUNT];
Servo ventServos[MAX_SYSTEM_COUNT];

// Create DHT objects for temp/humidity sensors
DHT* tempHumiditySensors[MAX_SYSTEM_COUNT];

// Forward declarations
float ADCtoPPFD(int);
int PPFDtoADC(float);
void readSensors();
void checkWaterStatus();
void adjustLighting();
void adjustVentilation();
char* readSerial();
void processSerialData(char*);
void executeCommand(char*, int, float);
bool validateRange(int, char*, int, int);

// ARDUINO SETUP
void setup() {

  // Bundle sensor pins, servo pins and servo objects
  const int* SENSOR_PINS[] = {LIGHT_SENSOR_PINS, TEMP_HUMIDITY_SENSOR_PINS};
  const int* SERVO_PINS[] = {WATER_SERVO_PINS, VENT_SERVO_PINS};
  Servo* servos[] = {waterServos, ventServos};

  // ATTACH SERVOS OBJECTS TO PINS
  // Loop through water and air vent servo lists
  for (int servoList = 0; servoList < sizeof(SERVO_PINS) / sizeof(int); servoList++) {
    
    // Loop through servos in list
    for (int servo = 0; servo < sizeof(SERVO_PINS[servoList]) / sizeof(int); servo++) {
      
      // Attach servo to pin
      servos[servoList][servo].attach(SERVO_PINS[servoList][servo]);
    }
  }
  for (int systemId = 0; systemId < MAX_SYSTEM_COUNT; systemId++){
    setVentPosition(systemId, ventManual[systemId]);
    waterServos[systemId].write(WATER_CLOSED_POSITION);
  }

  // SET SENSOR PINS TO INPUT 
  // Bundle sensor pins

  // Loop through light and temp/humidity sensor lists
  fo OBJECTS TO PINS
  // Loop through temp/humidity sensor lists
  for (int sensor = 0; sensor < MAX_SYSTEM_COUNT; sensor++) {

    // Attach DHT object to pin
    tempHumiditySensors[sensor] = new DHT(TEMP_HUMIDITY_SENSOR_PINS[sensor], DHTTYPE);
    temzpHumiditySensors[sensor]->begin();
  }

  // SET LED PINS TO OUTPUT
  for (int led = 0; led < MAX_SYSTEM_COUNT; led++) {
    if (LED_PINS[led] != -1) {
      pinMode(LED_PINS[led], OUTPUT);
    }
  }

  // Start LCD screen
  lcd.begin(16, 2);
  lcd.createChar(0, degreeSymbol);
  lcd.createChar(1, moonSymbol);
  lcd.setRGB(0, 255, 0);
  lcd.setCursor(0, 0);
  lcd.print("Bloombox");
  lcd.setCursor(0, 1);
  lcd.print("Starting...");

  // Begin serial communication
  Serial.begin(9600);

  // Wait for serial connection
  while(!Serial) { ; }
  Serial.println("Started");
  Serial.flush();
}

// MAIN LOOP
void loop() {
  
  char* incomingSerial;

  // Update LCD screen
  if (millis() - lastDisplayUpdate > DISPLAY_UPDATE_INTERVAL) {
    updateDisplay();
    lastDisplayUpdate = millis();
  }

  // Read sensor values if interval has passed
  if (millis() - lastReadingTime > readingInterval) {
    readSensors();
    lastReadingTime = millis();
  }

  // Check and update watering status
  checkWaterStatus();

  // Adjust light levels if interval has passed
  if (millis() - lastLightTime > lightInterval) {
    adjustLighting();
    lastLightTime = millis();
  }

  // Adjust ventilation if interval has passed
  if (millis() - lastVentTime > ventInterval) {
    adjustVentilation();
    lastVentTime = millis();
  }

  // Read and execute serial commands
  if (Serial.available() > 0) {
    processSerialData(readSerial());
  }
}

// HELPER FUNCTIONS

// Method to read sensor values and print them to serial
void readSensors() {
  
  Serial.println("READING SENSORS");
  
    // Loop through sensors
    for (int index = 0; index < systemCount; index++) {
      
      // Read sensor
      if (TEMP_HUMIDITY_SENSOR_PINS[index] != -1) {

        lastTempReadings[index] = tempHumiditySensors[index]->readTemperature();
        lastHumidityReadings[index] = tempHumiditySensors[index]->readHumidity();

        // Check if sensor reading failed
        if (isnan(lastTempReadings[index]) || isnan(lastHumidityReadings[index])) {
          lastTempReadings[index] = -1.0;
          lastHumidityReadings[index] = -1.0;
        }
      } else {
        lastTempReadings[index] = -1.0;
        lastHumidityReadings[index] = -1.0;
      }

      // Read sensor and convert voltage to PPFD
      if (LIGHT_SENSOR_PINS[index] != -1) {
        lastLightReadings[index] = ADCtoPPFD(analogRead(LIGHT_SENSOR_PINS[index]));
      } else {
        lastLightReadings[index] = -1.0;
      }

      // Print sensor values to serial
      Serial.print(index + 1);
      Serial.print(" temperature ");
      Serial.println(lastTempReadings[index]);
      Serial.print(index + 1);
      Serial.print(" humidity ");
      Serial.println(lastHumidityReadings[index]);
      Serial.print(index + 1);
      Serial.print(" light ");
      Serial.println(lastLightReadings[index]);
      
  }
  Serial.println("FINISHED READING SENSORS");
}

void updateDisplay() {

  // Switch system if interval has passed
  if (millis() - lastDisplaySwitch > DISPLAY_SWITCH_INTERVAL) {
    if (displayReading == 'T') {
      displayReading = 'H';
    } else if (displayReading == 'H') {
      displayReading = 'L';
    } else if (displayReading == 'L') {
      displayReading = 'T';
      displaySystem = (displaySystem + 1) % systemCount;
    }
    lastDisplaySwitch = millis();
  }
  lcd.clear();

  // Show system number on first line
  lcd.setCursor(0, 0);
  lcd.print(systemNames[displaySystem]);

  if (nightMode == true){
    lcd.setRGB(0, 0, 0);
    
    // Display night mode screen
    lcd.setCursor(0, 1);
    lcd.print("Night mode ");
    lcd.write((unsigned char)1);
  }
  else{
    lcd.setRGB(0, 255, 0);

    // Show readings on second line
    lcd.setCursor(0, 1);
    if (displayReading == 'T') {
      lcd.print("Temp: ");
      lcd.print(lastTempReadings[displaySystem], 1);
      lcd.write((unsigned char)0);
      lcd.print("C");
    } else if (displayReading == 'H') {
      lcd.print("Humidity: ");
      lcd.print(lastHumidityReadings[displaySystem], 0);
      lcd.print("%");
    } else if (displayReading == 'L') {
      lcd.print("Light: ");
      lcd.print(lastLightReadings[displaySystem], 0);
      lcd.print(" PPFD");
    }
  }
}

//Convert analog reading to PPFD
float ADCtoPPFD(int adc) {
  return adc;
}

// Convert PPFD to analogue (inverse of above)
int PPFDtoADC(float ppfd) {
  return constrain(ppfd, 0, 1023);
}

// Method to check if any servos have finished watering and close them
void checkWaterStatus() {

  // Loop through water timers
  for (int timer = 0; timer < systemCount; timer++) {

    // Check if timer has run out
    if (wateringTimers[timer] != 0 && millis() > wateringTimers[timer]) {

      // Close water servo and reset timer
      waterServos[timer].write(WATER_CLOSED_POSITION);
      wateringTimers[timer] = 0;
      Serial.print("closing water valve ");
      Serial.println(timer + 1);
    }
  }
}

// Open water valves method
void startWatering(int servoId, int duration){
  
  // Open water servo and set timer
  waterServos[servoId].write(WATER_OPEN_POSITION);
  wateringTimers[servoId] = millis() + duration * 1000;
  Serial.print("opening water valve ");
  Serial.print(servoId + 1);
  Serial.print(" for ") ;
  Serial.print(duration);
  Serial.println(" seconds");
}

// Set air vent servo's position method
void setVentPosition(int servoId, int openPercentage) {
  float newPosition = VENT_OPEN_POSITION + openPercentage * (VENT_CLOSED_POSITION - VENT_OPEN_POSITION) / 100;
  ventServos[servoId].write(newPosition);
  Serial.print("set position of air vent ");
  Serial.print(servoId + 1);
  Serial.print(" to ");
  Serial.print(openPercentage);
  Serial.println(" %");
}

// Method to set LEDs to auto or manual mode
void setLightMode(int systemId, char* newLedMode) {
  lightMode[systemId] = (strcmp(newLedMode, "auto") == 0) ? "auto" : "manual";
  Serial.print("set LED mode of system ");
  Serial.print(systemId + 1);
  Serial.print(" to ");
  Serial.println(newLedMode);
}

// Method to set ventilation to auto or manual mode
void setVentMode(int systemId, char* newVentMode) {
  ventMode[systemId] = (strcmp(newVentMode, "auto") == 0) ? "auto" : "manual";;
  Serial.print("set ventilation mode of system ");
  Serial.print(systemId + 1);
  Serial.print(" to ");
  Serial.println(newVentMode);
}

// Method to set the target light level (converts PPFD to voltage)
void setTargetLightLevel(int systemId, float newTargetLightLevel) {
  targetLightLevel[systemId] = PPFDtoADC(newTargetLightLevel);
  Serial.print("set target light level of lighting system ");
  Serial.print(systemId + 1);
  Serial.print(" to ");
  Serial.println(newTargetLightLevel);
}

// Method to set the target humidity
void setTargetHumidity(int systemId, float newTargetHumidity) {
  targetHumidity[systemId] = newTargetHumidity;
  Serial.print("set target humidity of air vent system ");
  Serial.print(systemId + 1);
  Serial.print(" to ");
  Serial.print(newTargetHumidity);
  Serial.println("%");
}

// Method to set manual LED brightness (converts percentage to 0-255)
void setLightManual(int systemId, int newLightManual) {
  lightManual[systemId] = newLightManual * 255 / 100;
  Serial.print("set manual LED brightness of system ");
  Serial.print(systemId + 1);
  Serial.print(" to ");
  Serial.print(newLightManual);
  Serial.println("%");
}

// Method to set manual ventilation position
void setVentManual(int systemId, int newVentManual) {
  ventManual[systemId] = newVentManual;
  Serial.print("set manual ventilation position of system ");
  Serial.print(systemId + 1);
  Serial.print(" to ");
  Serial.print(newVentManual);
  Serial.println("%");

}
// Method to set reading interval (converts to miliseconds)
void setReadingInterval(int newReadingInterval) {
  readingInterval = newReadingInterval * 1000;
  Serial.print("set reading interval to ");
  Serial.print(newReadingInterval);
  Serial.println(" seconds");
}

// Method to set light interval
void setLightInterval(int newLightInterval) {
  lightInterval = newLightInterval;
  Serial.print("set light interval to ");
  Serial.print(newLightInterval);
  Serial.println(" miliseconds");
}

// Method to set vent interval
void setVentInterval(int newVentInterval) {
  ventInterval = newVentInterval;
  Serial.print("set vent interval to ");
  Serial.print(newVentInterval);
  Serial.println(" miliseconds");
}

// Method to increase or decrease LED brightness based on light sensor readings, called periodically
void adjustLighting() {

  const int ADJUST_VALUE = 5; // Value to increase / decrease LED brightness by
  const int TOLERANCE = 10; // Light level tolerance
  const int STABLE_TIME = 100; // Time in milliseconds for LED brightness to be stable
  
  int sensorReading;
  int difference;
  int newBrightness;
  bool changed;

  // Only adjust lighting in daytime
  if (nightMode == true) {

    // Loop through lighting systems and set brightness to 0
    for (int lightingSystemId = 0; lightingSystemId < systemCount; lightingSystemId++) {
      analogWrite(LED_PINS[lightingSystemId], 0);
      currentLEDbrightness[lightingSystemId] = 0;
    }
  }
  else {
    
    // Loop through lighting systems
    for (int lightingSystemId = 0; lightingSystemId < systemCount; lightingSystemId++) {
  
      // Manual mode
      if (strcmp(lightMode[lightingSystemId], "manual") == 0) {
        if (currentLEDbrightness[lightingSystemId] != lightManual[lightingSystemId]) {
          currentLEDbrightness[lightingSystemId] = lightManual[lightingSystemId];
          analogWrite(LED_PINS[lightingSystemId], currentLEDbrightness[lightingSystemId]);
        }
      } 
      // Automatic mode
      else {
        changed = false;
        newBrightness = currentLEDbrightness[lightingSystemId];
    
        // Read sensor
        sensorReading = analogRead(LIGHT_SENSOR_PINS[lightingSystemId]);
        lastLightReadings[lightingSystemId] = ADCtoPPFD(sensorReading);
    
        // Calculate difference between target and sensor reading
        difference = targetLightLevel[lightingSystemId] - sensorReading;
    
        // Adjust current brightness if difference is greater than tollerance
        if (abs(difference) > TOLERANCE) {
    
          // Increase brightness if target is higher
          if (difference > 0 && currentLEDbrightness[lightingSystemId] != 255) {
            newBrightness = constrain(newBrightness + ADJUST_VALUE, 0, 255);
            changed = true;
          }
    
          // Decrease brightness if target is lower
          else if ( difference < 0 && currentLEDbrightness[lightingSystemId] != 0) {
            newBrightness = constrain(newBrightness - ADJUST_VALUE, 0, 255);
            changed = true;
          }
    
          // Check if brightness has changed
          if (changed == true) {
    
            // Reset timer
            lastLEDupdate[lightingSystemId] = millis();
            
            // Update current brightness
            currentLEDbrightness[lightingSystemId] = newBrightness;
    
            // Write new value to LED
            analogWrite(LED_PINS[lightingSystemId], currentLEDbrightness[lightingSystemId]);
          }
        }
    
        // Print message to serial if brightness has changed and it has been more than STABLE_TIME since the last change
        if (currentLEDbrightness[lightingSystemId] != previousLEDbrightness[lightingSystemId]
            && millis() - lastLEDupdate[lightingSystemId] > STABLE_TIME) {
          previousLEDbrightness[lightingSystemId] = currentLEDbrightness[lightingSystemId];
          Serial.print("LED brightness of lighting system ");
          Serial.print(lightingSystemId + 1);
          Serial.print(" adjusted to ");
          Serial.println(currentLEDbrightness[lightingSystemId]);
        }
      }
    } 
  }
}

// Method to open or close ventilation based on humidity readings, called periodically
void adjustVentilation() {

  const float TOLERANCE = 1.0; // Humidity tolerance
  const float MULTIPLIER = 2.0; // Multiplier for open percentage (new open percentage = difference * multiplier)

  float sensorReading;
  float difference;
  float newPosition;

  // Loop through ventilation systems
  for (int ventSystemId = 0; ventSystemId < systemCount; ventSystemId++) {

    // Manual mode
    if (strcmp(ventMode[ventSystemId], "manual") == 0) {
      if (currentVentPosition[ventSystemId] != ventManual[ventSystemId]) {
        currentVentPosition[ventSystemId] = ventManual[ventSystemId];
        setVentPosition(ventSystemId, ventManual[ventSystemId]);
      }
    }
    // Automatic mode
    else {
      newPosition = currentVentPosition[ventSystemId];

      // Read humidity
      sensorReading = tempHumiditySensors[ventSystemId]->readHumidity();
      lastHumidityReadings[ventSystemId] = sensorReading;

      // Exit if sensor reading failed
      if (isnan(sensorReading)) {
        continue;
      }

      // Calculate difference between target humidity and sensor reading
      difference = sensorReading - targetHumidity[ventSystemId];

      // Calculate new open percentage if difference is greater than tolerance
      if (abs(difference) > TOLERANCE) {
        newPosition = constrain(difference * MULTIPLIER, 0, 100);
      }

      // Set new vent position if it differs from the current position
      if (abs(newPosition - currentVentPosition[ventSystemId]) > 0.5) {
        currentVentPosition[ventSystemId] = newPosition;
        setVentPosition(ventSystemId, newPosition);
      }
    }
  }
}

// Method to read incoming serial data as a string
char* readSerial() {

  // Max character length for commands
  const int MAX_COMMAND_LENGTH = 50;

  // Buffer for incoming serial data
  static char incoming[MAX_COMMAND_LENGTH];
  char nextChar;
  int pointer = 0;

  // Loop through incoming serial data
  while (Serial.available() > 0 && pointer < MAX_COMMAND_LENGTH) {

    // Get next char
    nextChar = Serial.read();
    
    // If not at the end of the line
    if (nextChar != '\n') {

      // Add char to return string and increment pointer
      incoming[pointer] = nextChar;
      pointer++;
    }
    else {

      // Add null terminator to end of string and break
      incoming[pointer] = '\0';
      break;
    }
  }

  return incoming;
}
 
// Method to process incoming serial data
void processSerialData(char* incoming) {

  // Find the first space
  char* firstSpace = strchr(incoming, ' ');

  // If there are no spaces,then command only with no parameters
  if (firstSpace == NULL) {
    executeCommand(incoming, 0, "");
    return;
  }

  // Null-terminate the command
  *firstSpace = '\0';
  char* command = incoming;

  // Find the second space
  char* secondSpace = strchr(firstSpace + 1, ' ');
  int parameter1 = 0;
  char* parameter2 = "";

  // Only one parameter
  if (secondSpace == NULL) {
    parameter1 = atoi(firstSpace + 1);
  } 
  // Two parameters
  else {
    // Null-terminate parameter1
    *secondSpace = '\0';
    parameter1 = atoi(firstSpace + 1);

    // Everything after is parameter2
    parameter2 = secondSpace + 1;
  }

  executeCommand(command, parameter1, parameter2);
}

// Execute a command from serial
void executeCommand(char* command, int parameter1, char* parameter2){
  
  // NIGHT MODE COMMAND -> 'day / night'
  // Enable or disable night mode
  if (strcmp(command, "day") == 0) { 
    nightMode = false;
    Serial.println("night mode deactivated");
  }
  else if (strcmp(command, "night") == 0) {
    nightMode = true;
    Serial.println("night mode activated");
  }

  // SYSTEM NAME COMMAND -> 'systemName <system id> <name>'
  // Set the name of a device
  else if (strcmp(command, "systemName") == 0) {
    if (validateRange(parameter1, "system id", 1, MAX_SYSTEM_COUNT)) {
      strcpy(systemNames[parameter1 - 1], parameter2);
      Serial.print("set system ");
      Serial.print(parameter1);
      Serial.print(" name to ");
      Serial.println(parameter2);
    }
  }

  // SYSTEM COUNT COMMANDS -> 'systemCount <system count>'
  // Set the number of devices in each device set
  else if (strcmp(command, "systemCount") == 0) {
    if (validateRange(parameter1, "system count", 0, MAX_SYSTEM_COUNT)) {
      systemCount = parameter1;
      Serial.print("set system count to ");
      Serial.println(parameter1);
    }
  }

  // WATER COMMAND -> 'water <servo id> <duration in seconds>'
  // Opens a water servo for a certain duration
  else if (strcmp(command, "water") == 0) {
    if (validateRange(parameter1, "water servo id", 1, MAX_SYSTEM_COUNT) &&
        validateRange(atoi(parameter2), "water duration", 0, 86400)) { // Max of 86400 seconds in a day
      startWatering(parameter1 - 1, atoi(parameter2));
    }
  }

  // LIGHT MODE COMMAND -> 'lightMode <system id> <auto / manual>'
  // Set light mode for a system to auto or manual
  else if (strcmp(command, "lightMode") == 0) {
    if (validateRange(parameter1, "system id", 1, MAX_SYSTEM_COUNT) &&
        (strcmp(parameter2, "auto") == 0 || strcmp(parameter2, "manual") == 0)) {
      setLightMode(parameter1 - 1, parameter2);
    }
  }

  // VENT MODE COMMAND -> 'ventMode <system id> <auto / manual>'
  // Set ventilation mode for a system to auto or manual
  else if (strcmp(command, "ventMode") == 0) {
    if (validateRange(parameter1, "system id", 1, MAX_SYSTEM_COUNT) &&
        (strcmp(parameter2, "auto") == 0 || strcmp(parameter2, "manual") == 0)) {
      setVentMode(parameter1 - 1, parameter2);
    }
  }
  
  // TARGET LIGHT LEVEL COMMAND -> 'targetLight <system id> <target brightness PPFD>'
  // Sets the target light level that should be maintained
  else if (strcmp(command, "targetLight") == 0) {
    if (validateRange(parameter1, "light id", 1, MAX_SYSTEM_COUNT) &&
        validateRange(atoi(parameter2), "target light-level", 0, 1000)){
      setTargetLightLevel(parameter1 - 1, atoi(parameter2));
    }
  }

  // TARGET HUMIDITY LEVEL COMMAND -> 'targetHumidity <system id> <target humidity>'
  // Sets the target humidity that should be maintained
  else if (strcmp(command, "targetHumidity") == 0) {
    if (validateRange(parameter1, "vent id", 1, MAX_SYSTEM_COUNT) &&
        validateRange(atoi(parameter2), "target humidity", 0, 100)){
      setTargetHumidity(parameter1 - 1, atoi(parameter2));
    }
  }

  // MANUAL LIGHT COMMAND -> 'lightManual <system id> <brightness percentage>'
  // Manually set the light level of a system to a certain percentage
  else if (strcmp(command, "lightManual") == 0) {
    if (validateRange(parameter1, "light id", 1, MAX_SYSTEM_COUNT) &&
        validateRange(atoi(parameter2), "LED brightness", 0, 100)){
      setLightManual(parameter1 - 1, atoi(parameter2));
    }
  }

  // MANUAL VENT COMMAND -> 'ventManual <system id> <open percentage>'
  // Manually set the vent position of a system to a certain percentage
  else if (strcmp(command, "ventManual") == 0) {
    if (validateRange(parameter1, "vent id", 1, MAX_SYSTEM_COUNT) &&
        validateRange(atoi(parameter2), "vent position", 0, 100)){
      setVentManual(parameter1 - 1, atoi(parameter2));
    }
  }

  // READING INTERVAL COMMAND -> 'readingInterval <seconds>'
  // Sets the reading interval
  else if (strcmp(command, "readingInterval") == 0) {
    if (validateRange(parameter1, "reading interval", 0, 86400)) { // Max of 86400 seconds in a day
      setReadingInterval(parameter1);
    }
  }

  // LIGHTING INTERVAL COMMAND -> 'lightingInterval <seconds>'
  // Sets the lighting interval
  else if (strcmp(command, "lightInterval") == 0) {
    if (validateRange(parameter1, "lighting interval", 0, 86400)) { // Max of 86400 seconds in a day
      setLightInterval(parameter1);
    }
  }

  // VENT INTERVAL COMMAND -> 'ventInterval <seconds>'
  // Sets the ventilation interval
  else if (strcmp(command, "ventInterval") == 0) {
    if (validateRange(parameter1, "ventilation interval", 0, 86400)) { // Max of 86400 seconds in a day
      setVentInterval(parameter1);
    }
  }

  // Unrecognized command
  else {
    Serial.print("error: ");
    Serial.print(command);
    Serial.println(" is not a valid command");
  }
}

// SERIAL INPUT VALIDATION

// Function to check that an input falls between a min and max value (inclusive)
bool validateRange(int input, char* name, int minimum, int maximum) {  

  if (input < minimum || input > maximum) {  
    Serial.print("error: ");
    Serial.print(input);
    Serial.print(" is not a valid ");
    Serial.println(name);
    return false;
  }
  return true;
}
