const elements = {
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  scanFileButton: document.getElementById("scanFileButton"),
  torchButton: document.getElementById("torchButton"),
  copyButton: document.getElementById("copyButton"),
  clearHistoryButton: document.getElementById("clearHistoryButton"),
  fileInput: document.getElementById("fileInput"),
  resultText: document.getElementById("resultText"),
  formatText: document.getElementById("formatText"),
  sourceText: document.getElementById("sourceText"),
  statusText: document.getElementById("statusText"),
  cameraState: document.getElementById("cameraState"),
  historyList: document.getElementById("historyList"),
};

const historyKey = "qrreaderpro-history";
const scanHistory = readHistory();
const fastFormats = [
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.CODABAR,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.UPC_EAN_EXTENSION,
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
  Html5QrcodeSupportedFormats.PDF_417,
];

let scanner = null;
let currentText = "";
let currentCameraId = null;
let activeTrack = null;
let torchEnabled = false;
let isRunning = false;
let lastTouchEnd = 0;
let audioContext = null;
let lastBeepAt = 0;
let lastScanAt = 0;
let resumeTimeout = null;
let popupElements = null;

renderHistory();
ensurePopupElements();

elements.startButton.addEventListener("click", startScanner);
elements.stopButton.addEventListener("click", stopScanner);
elements.scanFileButton.addEventListener("click", () => elements.fileInput.click());
elements.copyButton.addEventListener("click", copyResult);
elements.clearHistoryButton.addEventListener("click", clearHistory);
elements.fileInput.addEventListener("change", scanSelectedFile);
elements.torchButton.addEventListener("click", toggleTorch);
document.addEventListener("keydown", handleGlobalKeydown);

registerServiceWorker();
installMobileGuards();

async function startScanner() {
  if (!window.Html5Qrcode) {
    updateStatus("Tarayıcı kütüphanesi yüklenemedi.", false);
    return;
  }

  try {
    elements.startButton.disabled = true;
    updateStatus("Kamera hazırlanıyor...", false);

    const cameras = await Html5Qrcode.getCameras();
    if (!cameras.length) {
      throw new Error("Kullanılabilir kamera bulunamadı.");
    }

    const preferredCamera = pickRearCamera(cameras);
    currentCameraId = preferredCamera.id;

    if (!scanner) {
      scanner = new Html5Qrcode("reader", {
        formatsToSupport: fastFormats,
        verbose: false,
      });
    }

    await scanner.start(
      { deviceId: { exact: currentCameraId } },
      {
        fps: 20,
        rememberLastUsedCamera: true,
        videoConstraints: {
          facingMode: "environment",
          width: { ideal: 1280, min: 640 },
          height: { ideal: 720, min: 480 },
        },
        disableFlip: true,
      },
      onScanSuccess,
      () => {}
    );

    isRunning = true;
    bindActiveTrack();
    elements.stopButton.disabled = false;
    elements.torchButton.disabled = !canToggleTorch();
    updateStatus("Kamera aktif. Barkodu yatay alana yaklaştırın.", true);
  } catch (error) {
    console.error(error);
    updateStatus(getReadableError(error), false);
    elements.startButton.disabled = false;
    elements.stopButton.disabled = true;
    elements.torchButton.disabled = true;
  }
}

async function stopScanner() {
  if (!scanner || !isRunning) {
    return;
  }

  try {
    await scanner.stop();
    await scanner.clear();
  } catch (error) {
    console.error(error);
  } finally {
    isRunning = false;
    activeTrack = null;
    torchEnabled = false;
    elements.startButton.disabled = false;
    elements.stopButton.disabled = true;
    elements.torchButton.disabled = true;
    elements.torchButton.textContent = "Flaş";
    updateStatus("Kamera durduruldu.", false);
  }
}

function onScanSuccess(decodedText, decodedResult) {
  const now = Date.now();
  if (decodedText === currentText && now - lastScanAt < 1500) {
    return;
  }

  currentText = decodedText;
  lastScanAt = now;
  playBeep();
  const payload = {
    text: decodedText,
    format: normalizeFormat(decodedResult?.result?.format?.formatName),
    source: "Canlı kamera",
    scannedAt: new Date().toLocaleString("tr-TR"),
  };
  setResult(payload);
  openResultModal(payload);
  pauseLivePreview();
}

async function scanSelectedFile(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  if (!window.Html5Qrcode) {
    updateStatus("Tarayıcı kütüphanesi yüklenemedi.", false);
    return;
  }

  try {
    if (isRunning) {
      await stopScanner();
    }

    updateStatus("Resim analiz ediliyor...", false);
    const fileScanner = new Html5Qrcode("reader");
    const result = await fileScanner.scanFile(file, true);
    await fileScanner.clear();

    currentText = result;
    playBeep();
    const payload = {
      text: result,
      format: "Otomatik tespit",
      source: "Yüklenen görsel",
      scannedAt: new Date().toLocaleString("tr-TR"),
    };
    setResult(payload);
    openResultModal(payload);
    updateStatus("Görselden barkod okundu.", true);
  } catch (error) {
    console.error(error);
    updateStatus("Seçilen görselden barkod okunamadı.", false);
  } finally {
    elements.fileInput.value = "";
  }
}

async function copyResult() {
  if (!currentText) {
    return;
  }

  try {
    await navigator.clipboard.writeText(currentText);
    updateStatus("Sonuç panoya kopyalandı.", true);
  } catch (error) {
    console.error(error);
    updateStatus("Panoya kopyalama başarısız oldu.", false);
  }
}

async function toggleTorch() {
  if (!activeTrack) {
    return;
  }

  try {
    torchEnabled = !torchEnabled;
    await activeTrack.applyConstraints({
      advanced: [{ torch: torchEnabled }],
    });
    elements.torchButton.textContent = torchEnabled ? "Flaş Kapat" : "Flaş";
  } catch (error) {
    console.error(error);
    torchEnabled = false;
    elements.torchButton.textContent = "Flaş";
    updateStatus("Bu cihazda flaş kontrolü desteklenmiyor.", false);
  }
}

function setResult({ text, format, source, scannedAt }) {
  elements.resultText.textContent = text;
  elements.formatText.textContent = format || "-";
  elements.sourceText.textContent = source || "-";
  elements.copyButton.disabled = false;

  const item = {
    text,
    format: format || "-",
    source: source || "-",
    timestamp: scannedAt || new Date().toLocaleString("tr-TR"),
  };

  scanHistory.unshift(item);
  scanHistory.splice(10);
  localStorage.setItem(historyKey, JSON.stringify(scanHistory));
  renderHistory();
}

function renderHistory() {
  if (!scanHistory.length) {
    elements.historyList.innerHTML = '<li class="history-empty">Henüz tarama yapılmadı.</li>';
    return;
  }

  elements.historyList.innerHTML = scanHistory
    .map(
      (item) => `
        <li class="history-item">
          <div class="history-row">
            <strong>${escapeHtml(item.format)}</strong>
            <span class="history-meta">${escapeHtml(item.timestamp)}</span>
          </div>
          <p class="history-value">${escapeHtml(item.text)}</p>
        </li>
      `
    )
    .join("");
}

function clearHistory() {
  scanHistory.length = 0;
  localStorage.removeItem(historyKey);
  renderHistory();
}

function updateStatus(message, active) {
  elements.statusText.textContent = message;
  elements.cameraState.textContent = active ? "Aktif" : "Pasif";
  elements.cameraState.classList.toggle("active", active);
}

function readHistory() {
  try {
    return JSON.parse(localStorage.getItem(historyKey) || "[]");
  } catch {
    return [];
  }
}

function pickRearCamera(cameras) {
  return (
    cameras.find((camera) => /back|rear|environment|arka/i.test(camera.label)) ||
    cameras[0]
  );
}

function createScanBox(viewfinderWidth, viewfinderHeight) {
  const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.72);
  return {
    width: Math.max(220, edge),
    height: Math.max(220, edge),
  };
}

function normalizeFormat(format) {
  return format?.replaceAll("_", " ") || "Bilinmiyor";
}

function bindActiveTrack() {
  const video = document.querySelector("#reader video");
  activeTrack = video?.srcObject?.getVideoTracks?.()[0] || null;
}

function canToggleTorch() {
  const capabilities = activeTrack?.getCapabilities?.();
  return Boolean(capabilities?.torch);
}

function getReadableError(error) {
  const message = String(error?.message || error || "");
  if (/permission|denied|allowed/i.test(message)) {
    return "Kamera izni verilmedi. Tarayıcı izinlerini kontrol edin.";
  }

  if (/secure|https/i.test(message)) {
    return "Kamera için HTTPS veya localhost gerekir.";
  }

  return "Kamera başlatılamadı. Başka bir uygulama kamerayı kullanıyor olabilir.";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function playBeep() {
  const now = Date.now();
  if (now - lastBeepAt < 350) {
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  try {
    audioContext = audioContext || new AudioContextClass();
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const startAt = audioContext.currentTime;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(1046.5, startAt);
    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.exponentialRampToValueAtTime(0.18, startAt + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.12);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start(startAt);
    oscillator.stop(startAt + 0.12);
    lastBeepAt = now;
  } catch (error) {
    console.error("Beep playback failed:", error);
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  });
}

function installMobileGuards() {
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    },
    { passive: false }
  );

  document.addEventListener(
    "gesturestart",
    (event) => {
      event.preventDefault();
    },
    { passive: false }
  );

  document.addEventListener(
    "dblclick",
    (event) => {
      event.preventDefault();
    },
    { passive: false }
  );

  document.addEventListener(
    "touchend",
    (event) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) {
        event.preventDefault();
      }
      lastTouchEnd = now;
    },
    { passive: false }
  );
}

function openResultModal({ text, format, source, scannedAt }) {
  ensurePopupElements();
  const decodedFields = buildDecodedFields(text, format);
  popupElements.resultText.textContent = text || "-";
  popupElements.formatText.textContent = format || "-";
  popupElements.sourceText.textContent = source || "-";
  popupElements.timeText.textContent = scannedAt || new Date().toLocaleString("tr-TR");
  popupElements.lengthText.textContent = text ? `${text.length} karakter` : "-";
  popupElements.decodedFields.innerHTML = decodedFields
    .map(
      (item) => `
        <article class="decoded-item">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.value)}</span>
        </article>
      `
    )
    .join("");

  popupElements.root.hidden = false;
  popupElements.root.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  popupElements.root.classList.add("is-visible");
}

function closeResultModal() {
  if (!popupElements?.root) {
    return;
  }

  popupElements.root.hidden = true;
  popupElements.root.setAttribute("aria-hidden", "true");
  popupElements.root.classList.remove("is-visible");
  document.body.classList.remove("modal-open");
  scheduleLiveResume();
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape" && popupElements?.root && !popupElements.root.hidden) {
    closeResultModal();
  }
}

function pauseLivePreview() {
  clearTimeout(resumeTimeout);
  if (!isRunning || !activeTrack) {
    return;
  }

  try {
    activeTrack.enabled = false;
    updateStatus("Barkod okundu. Detay penceresi açık.", true);
  } catch (error) {
    console.error(error);
  }
}

function scheduleLiveResume() {
  clearTimeout(resumeTimeout);
  if (!isRunning || !activeTrack) {
    return;
  }

  resumeTimeout = window.setTimeout(() => {
    try {
      activeTrack.enabled = true;
      updateStatus("Kamera aktif. Yeni barkod için hazır.", true);
    } catch (error) {
      console.error(error);
    }
  }, 120);
}

function buildDecodedFields(text, format) {
  const value = String(text || "").trim();
  const items = [
    { label: "Ham veri", value: value || "-" },
    { label: "Veri tipi", value: detectValueType(value) },
  ];

  if (/^\d+$/.test(value)) {
    items.push({ label: "Sadece rakam", value: "Evet" });
  }

  if (/^[A-Z0-9-]+$/i.test(value)) {
    items.push({ label: "Kod yapısı", value: "Alfanümerik seri / stok kodu olabilir" });
  }

  if (/\d{2}\/\d{2}\/\d{4}/.test(value)) {
    items.push({ label: "Tarih bulundu", value: value.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] || "-" });
  }

  if (format && /EAN|UPC/.test(format)) {
    items.push({ label: "Ürün kodu yorumu", value: "Perakende ürün barkodu formatı" });
  }

  if (format && /CODE 128|CODE 39|CODE 93|ITF|CODABAR/.test(format)) {
    items.push({ label: "Endüstriyel kullanım", value: "Stok, koli, raf veya tedarik etiketi olabilir" });
  }

  if (value.includes("http://") || value.includes("https://")) {
    items.push({ label: "Bağlantı", value: value });
  }

  return items;
}

function detectValueType(value) {
  if (!value) {
    return "Bilinmiyor";
  }

  if (/^https?:\/\//i.test(value)) {
    return "URL";
  }

  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    return "E-posta";
  }

  if (/^\d+$/.test(value)) {
    return "Sayısal barkod / seri";
  }

  return "Metin / alfanümerik kod";
}

function ensurePopupElements() {
  if (popupElements?.root) {
    return popupElements;
  }

  const root = document.createElement("div");
  root.className = "js-popup";
  root.hidden = true;
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="js-popup-backdrop" data-close-popup="true"></div>
    <section class="js-popup-panel" role="dialog" aria-modal="true" aria-labelledby="jsPopupTitle">
      <button class="js-popup-close" id="jsPopupCloseButton" type="button" aria-label="Kapat">×</button>
      <div class="js-popup-head">
        <span class="label">Tarama tamamlandı</span>
        <h2 id="jsPopupTitle">Barkod Detayı</h2>
      </div>
      <div class="result-grid modal-content">
        <div class="result-box">
          <span class="label">İçerik</span>
          <p id="jsPopupResultText" class="result-text"></p>
        </div>
        <div class="meta-grid">
          <div class="meta-box">
            <span class="label">Format</span>
            <p id="jsPopupFormatText">-</p>
          </div>
          <div class="meta-box">
            <span class="label">Kaynak</span>
            <p id="jsPopupSourceText">-</p>
          </div>
          <div class="meta-box">
            <span class="label">Okunma Zamanı</span>
            <p id="jsPopupTimeText">-</p>
          </div>
          <div class="meta-box">
            <span class="label">Uzunluk</span>
            <p id="jsPopupLengthText">-</p>
          </div>
        </div>
        <div class="result-box">
          <span class="label">Çözümlenen Bilgiler</span>
          <div id="jsPopupDecodedFields" class="decoded-list"></div>
        </div>
      </div>
    </section>
  `;

  document.body.appendChild(root);

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.closePopup === "true") {
      closeResultModal();
    }
  });

  root.querySelector("#jsPopupCloseButton")?.addEventListener("click", closeResultModal);

  popupElements = {
    root,
    resultText: root.querySelector("#jsPopupResultText"),
    formatText: root.querySelector("#jsPopupFormatText"),
    sourceText: root.querySelector("#jsPopupSourceText"),
    timeText: root.querySelector("#jsPopupTimeText"),
    lengthText: root.querySelector("#jsPopupLengthText"),
    decodedFields: root.querySelector("#jsPopupDecodedFields"),
  };

  return popupElements;
}

window.addEventListener("beforeunload", () => {
  if (scanner && isRunning) {
    scanner.stop().catch(() => {});
  }
});
