// TEXT SIZE - with persistence
const savedTextSize = localStorage.getItem("textSize") || "normal";
applyTextSize(savedTextSize);

const textSize = document.getElementById("textSize");
if (textSize) {
  textSize.value = savedTextSize;
  textSize.addEventListener("change", function () {
    applyTextSize(this.value);
    localStorage.setItem("textSize", this.value);
  });
}

function applyTextSize(size) {
  if (size === "small")  document.body.style.fontSize = "80%";
  if (size === "normal") document.body.style.fontSize = "100%";
  if (size === "large")  document.body.style.fontSize = "120%";
  if (size === "xlarge") document.body.style.fontSize = "150%";
}

// DARK MODE + HIGH CONTRAST - mutually exclusive, with persistence
const darkMode = document.getElementById("darkMode");
const highContrast = document.getElementById("highContrast");

// Restore on page load (else if ensures only one can be active)
if (localStorage.getItem("darkMode") === "true") {
  document.body.classList.add("dark-mode");
  if (darkMode) darkMode.checked = true;
} else if (localStorage.getItem("highContrast") === "true") {
  document.body.classList.add("high-contrast");
  if (highContrast) highContrast.checked = true;
}

if (darkMode) {
  darkMode.addEventListener("change", function () {
    if (this.checked) {
      document.body.classList.remove("high-contrast");
      localStorage.setItem("highContrast", "false");
      if (highContrast) highContrast.checked = false;
    }
    document.body.classList.toggle("dark-mode", this.checked);
    localStorage.setItem("darkMode", this.checked);
  });
}

if (highContrast) {
  highContrast.addEventListener("change", function () {
    if (this.checked) {
      document.body.classList.remove("dark-mode");
      localStorage.setItem("darkMode", "false");
      if (darkMode) darkMode.checked = false;
    }
    document.body.classList.toggle("high-contrast", this.checked);
    localStorage.setItem("highContrast", this.checked);
  });
}