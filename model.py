from PIL import Image
import os
import tensorflow as tf
from tensorflow.keras import layers, models
import numpy as np
import matplotlib.pyplot as plt
from tensorflow.keras.preprocessing import image
import cv2
import pathlib

IMG_SIZE = 224
#How many pics are processed at a time
BATCH_SIZE = 32
#How many times the model sees the dataset
EPOCHS = 10
DATASET_PATH = 'PlantVillage/PlantVillage'
model = tf.keras.models.load_model("plant_stress_model.h5")

#Goes through all the sub-folders and gets the path and then assigns labels 0 for healthy 1 for stressed
def load_binary_dataset(dataset_path, img_size, batch_size):
    all_image_paths = []
    all_labels = []

    for split in ['Healthy', 'Stressed']:
        label = 0 if split == 'Healthy' else 1
        split_path = pathlib.Path(dataset_path) / split

        # Walk through all subfolders and finds all images
        for img_path in split_path.rglob('*'):
            if img_path.suffix.lower() in ['.jpg', '.jpeg', '.png', '.webp']:
                all_image_paths.append(str(img_path))
                all_labels.append(label)

    return all_image_paths, all_labels

#File to tensor to resized img
def parse_image(img_path, label, img_size):
    img = tf.io.read_file(img_path)
    img = tf.image.decode_image(img, channels=3, expand_animations=False)
    img = tf.image.resize(img, [img_size, img_size])
    return img, label

#Turns lists into a TensorFlow dataset
def build_tf_dataset(paths, labels, img_size, batch_size, shuffle=False):
    ds = tf.data.Dataset.from_tensor_slices((paths, labels))
    if shuffle:
        ds = ds.shuffle(buffer_size=len(paths), seed=123)
    ds = ds.map(lambda p, l: parse_image(p, l, img_size),
                num_parallel_calls=tf.data.AUTOTUNE)
    ds = ds.batch(batch_size).prefetch(tf.data.AUTOTUNE)
    return ds

def train_model():
    all_paths, all_labels = load_binary_dataset(DATASET_PATH, IMG_SIZE, BATCH_SIZE)

    # Manual 80/20 split
    combined = list(zip(all_paths, all_labels))
    np.random.shuffle(combined)

    all_paths, all_labels = zip(*combined)
    all_paths = list(all_paths)
    all_labels = list(all_labels)
    print("Total Images: ", len(all_paths))

    split = int(0.8 * len(all_paths))

    train_ds = build_tf_dataset(all_paths[:split], all_labels[:split],
                                IMG_SIZE, BATCH_SIZE, shuffle=True)
    val_ds   = build_tf_dataset(all_paths[split:], all_labels[split:],
                                IMG_SIZE, BATCH_SIZE)

    class_names = ['Healthy', 'Stressed']
    print('Classes: ', class_names)

    AUTOTUNE = tf.data.AUTOTUNE

    #Adds randomness to help model generalise
    data_augmentation = tf.keras.Sequential([
        layers.RandomFlip('horizontal'),
        layers.RandomRotation(0.1),
        layers.RandomZoom(0.1),
        layers.RandomContrast(0.2),
        layers.RandomBrightness(0.2),
    ])

    train_ds = train_ds.map(lambda x, y: (data_augmentation(x),y))
    train_ds = train_ds.prefetch(buffer_size = AUTOTUNE)
    val_ds = val_ds.prefetch(buffer_size = AUTOTUNE)

    #MobileNetV2 extracts features from image
    base_model = tf.keras.applications.MobileNetV2(
        input_shape= (IMG_SIZE, IMG_SIZE, 3),
        include_top = False,
        weights = 'imagenet'
    )

    base_model.trainable = False

    model = models.Sequential([
        layers.Rescaling(1./255),
        base_model,
        #Compressed features into a vector
        layers.GlobalAveragePooling2D(),
        #Learns patterns like colour,texture and damage
        layers.Dense(128, activation='relu'),
        layers.Dropout(0.5),
        layers.Dense(1, activation = 'sigmoid')
    ])

    model.compile(
        optimizer = 'adam',
        loss = 'binary_crossentropy',
        metrics = ['accuracy']
    )

    model.summary()

    history = model.fit(
        train_ds,
        validation_data = val_ds,
        epochs = EPOCHS
    )

    loss, accuracy = model.evaluate(val_ds)
    print(f"\nValidation Accuracy: {accuracy:.2f}")

    model.save("plant_stress_model.h5")
    print("Model saved!")
    model = tf.keras.models.load_model("plant_stress_model.h5")

    return model

def predict_stress_percentage(img_path, model):
    img = cv2.imread(img_path)
    img = cv2.resize(img, (IMG_SIZE, IMG_SIZE))
    img = img.astype(np.float32)

    img = np.expand_dims(img ,axis = 0)

    prediction = model.predict(img)[0][0]

    stress_percentage = prediction * 100
    health_percentage = (1 - prediction) * 100

    if stress_percentage < 30:
        status = 'Healthy'
    elif stress_percentage < 60:
        status = 'Mild Stress'
    else:
        status = 'Severe Stress'
    
    print(f'Diagnosis: {status}')

    return stress_percentage

test_image_path = 'rose_plant_test.jpg'

h_count = 0
s_count = 0

for root_dir, cur_dir, files in os.walk('PlantVillage/PlantVillage/Healthy'):
    h_count += len(files)

for root_dir, cur_dir, files in os.walk('PlantVillage/PlantVillage/Stressed'):
    s_count += len(files)

print(f'Healthy: {h_count}')
print(f'Stressed: {s_count}')

if not os.path.exists('plant_stress_model.h5'):
    model = train_model()
else:
    model = tf.keras.models.load_model("plant_stress_model.h5")

predict_stress_percentage(test_image_path,model)