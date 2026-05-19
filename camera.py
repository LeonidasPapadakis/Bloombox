import os
import time
import datetime

import cv2
import numpy as np
import tflite_runtime.interpreter as tflite
from flask import Flask, jsonify, Response, send_from_directory
from picamera2 import Picamera2
from flask_cors import CORS
import json

app = Flask(__name__)
CORS(app)

cam = Picamera2()
camera_config = cam.create_video_configuration(
    main = {"size": (1920, 1080), "format": "RGB888"}
)
cam.configure(camera_config)
cam.start()
time.sleep(3)

metadata = cam.capture_metadata()

cam.set_controls({
    "AwbEnable": True,
    "AeEnable": True,
    "Brightness": 0.0,
    "Contrast": 1.0,
    "Saturation": 1.0,
    "Sharpness": 1.0
})

IMG_SIZE = 224
#How many pics are processed at a time
BATCH_SIZE = 32
#How many times the model sees the dataset
EPOCHS = 10
DATASET_PATH = 'PlantVillage/PlantVillage'
PHOTO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'photos')
HISTORY_FILE = "scan_history.json"
os.makedirs(PHOTO_DIR, exist_ok = True)

interpreter = tflite.Interpreter(model_path='plant_stress_model.tflite')
interpreter.allocate_tensors()

input_details = interpreter.get_input_details()
output_details = interpreter.get_output_details()

def predict_stress_percentage(frame):
    date_time = datetime.datetime.now().isoformat()

    frame = cv2.resize(frame, (IMG_SIZE, IMG_SIZE))
    frame = frame.astype(np.float32)
    frame = np.expand_dims(frame, axis = 0)

    interpreter.set_tensor(input_details[0]['index'], frame)
    interpreter.invoke()

    prediction = interpreter.get_tensor(output_details[0]['index'])[0][0]

    stress_percentage = float(prediction * 100)
    health_percentage = (1 - prediction) * 100

    if stress_percentage < 30:
        status = 'Healthy'
    elif stress_percentage < 60:
        status = 'Mild Stress'
    else:
        status = 'Severe Stress'
    
    print(f'Diagnosis: {status}')

    return stress_percentage, status, date_time

def color_metrics(frame):
    hsv = cv2.cvtColor(frame, cv2.COLOR_RGB2HSV)

    total_pixels = frame.shape[0] * frame.shape[1]

    green_lower = np.array([35, 40, 40])
    green_upper = np.array([85, 255, 255])
    green_mask = cv2.inRange(hsv, green_lower, green_upper)

    yellow_lower = np.array([20, 50, 50])
    yellow_upper = np.array([35, 255, 255])
    yellow_mask = cv2.inRange(hsv, yellow_lower, yellow_upper)

    green_percent = (cv2.countNonZero(green_mask) / total_pixels) * 100
    yellow_percent = (cv2.countNonZero(yellow_mask) / total_pixels) * 100

    return round(green_percent), round(yellow_percent)

def save_scan(data):
    history = []

    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, "r") as f:
            history = json.load(f)
    
    history.append(data)

    with open(HISTORY_FILE, "w") as f:
        json.dump(history,f, indent = 4)

def plant_height_percent(frame):
    hsv = cv2.cvtColor(frame, cv2.COLOR_RGB2HSV)

    lower =  np.array([20, 40, 40])
    upper = np.array([90, 255, 255])
    mask = cv2.inRange(hsv, lower, upper)

    kernel = np.ones((5, 5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    total = cv2.countNonZero(mask)
    if total == 0:
        return 0

    mid = frame.shape[0] // 2
    lower_half = cv2.countNonZero(mask[mid:, :])

    return round((lower_half / total) * 100)


@app.route("/predict")
def predict():
    frame = cam.capture_array()
    frame = cv2.rotate(frame, cv2.ROTATE_180)
    green_vibrancy, yellow_pixel = color_metrics(frame)
    plant_height = plant_height_percent(frame)
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"BBPhoto_{timestamp}.jpg"
    filepath = os.path.join(PHOTO_DIR, filename)

    os.makedirs(PHOTO_DIR, exist_ok=True)
    cv2.imwrite(filepath, frame)

    stress, status, date_time = predict_stress_percentage(frame)

    scan_data = {
        "stress": stress,
        "status": status,
        "date_time":date_time,
        "photo_url": f"/camera/photos/{filename}",
        "green_vibrancy": green_vibrancy,
        "yellow_pixel": yellow_pixel,
        "plant_height": plant_height
    }

    save_scan(scan_data)

    return jsonify(scan_data)

@app.route("/comparison")
def comparison():
    if not os.path.exists(HISTORY_FILE):
        return jsonify({"error": "No scan history found"}),404
    
    with open(HISTORY_FILE, "r") as f:
        history = json.load(f)
    
    if len(history) < 2:
        return jsonify({"error": "Not enough scans"}), 400
    
    today_scan = history[-1]

    today_date = datetime.datetime.fromisoformat(today_scan["date_time"])
    target_date = today_date - datetime.timedelta(days = 7)

    seven_days_ago = min(
        history,
        key = lambda scan: abs(
            datetime.datetime.fromisoformat(scan["date_time"]) - target_date
        )
    )

    difference = round(seven_days_ago["stress"] - today_scan["stress"])

    if difference > 0:
        message = f"Plant health has improved over the past 7 days. Stress reduced by {difference} points."
    elif difference < 0:
        message = f"Plant health has declined over the past 7 days. Stress increased by {abs(difference)} points."
    else:
        message = "Plant health has stayed the same over the past 7 days."

    return jsonify({
        "seven_days_ago": seven_days_ago,
        "today": today_scan,
        "difference": difference,
        "message": message
    })
def live_feed():
    while True:
        frame = cam.capture_array()
        frame = cv2.rotate(frame, cv2.ROTATE_180)

        success, buffer = cv2.imencode(".jpg", frame)

        if not success:
            print("JPEG encode failed")
            continue

        yield(
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" +
            buffer.tobytes() +
            b"\r\n"
        )

        time.sleep(0.1)

@app.route('/stream')
def stream():
    return Response(
        live_feed(),
        headers={
            "Content-type": "multipart/x-mixed-replace; boundary=frame",
            "Cache-control": "no-cache",
            "Connection": "close",
        }
    )

@app.route("/photos/<filename>")
def photos(filename):
    return send_from_directory(PHOTO_DIR, filename)

def take_photo(camera, photos):
    camera.capture_file(os.path.join(PHOTO_DIR, f'BBPhoto{datetime.datetime.now()}.jpg'))

def delete_photos(photo_path):
    os.remove(photo_path)

#Task: Make the pi's camera take photos at specified intervals to capture the plant
if __name__ == '__main__':
    app.run(host = "0.0.0.0", port = 5000, threaded = True)
    