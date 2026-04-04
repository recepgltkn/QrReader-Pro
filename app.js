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
  resultModal: document.getElementById("resultModal"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  closeModalButton: document.getElementById("closeModalButton"),
  modalResultText: document.getElementById("modalResultText"),
  modalFormatText: document.getElementById("modalFormatText"),
  modalSourceText: document.getElementById("modalSourceText"),
  modalTimeText: document.getElementById("modalTimeText"),
  modalLengthText: document.getElementById("modalLengthText"),
  decodedFields: document.getElementById("decodedFields"),
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

renderHistory();

elements.startButton.addEventListener("click", startScanner);
elements.stopButton.addEventListener("click", stopScanner);
elements.scanFileButton.addEventListener("click", () => elements.fileInput.click());
elements.copyButton.addEventListener("click", copyResult);
elements.clearHistoryButton.addEventListener("click", clearHistory);
elements.fileInput.addEventListener("change", scanSelectedFile);
elements.torchButton.addEventListener("click", toggleTorch);
elements.closeModalButton.addEventListener("click", closeResultModal);
elements.modalBackdrop.addEventListener("click", closeResultModal);
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
        fps: 30,
        qrbox: createScanBox,
        rememberLastUsedCamera: true,
        videoConstraints: {
          facingMode: "environment",
          width: { ideal: 960, max: 1280 },
          height: { ideal: 540, max: 720 },
          focusMode: "continuous",
        },
        disableFlip: true,
        aspectRatio: 1.777778,
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
  const width = Math.floor(Math.min(viewfinderWidth * 0.88, 480));
  const height = Math.floor(Math.max(68, Math.min(viewfinderHeight * 0.22, 104)));
  return { width, height };
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
  const decodedFields = buildDecodedFields(text, format);
  elements.modalResultText.textContent = text || "-";
  elements.modalFormatText.textContent = format || "-";
  elements.modalSourceText.textContent = source || "-";
  elements.modalTimeText.textContent = scannedAt || new Date().toLocaleString("tr-TR");
  elements.modalLengthText.textContent = text ? `${text.length} karakter` : "-";
  elements.decodedFields.innerHTML = decodedFields
    .map(
      (item) => `
        <article class="decoded-item">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.value)}</span>
        </article>
      `
    )
    .join("");

  elements.resultModal.hidden = false;
  elements.resultModal.setAttribute("aria-hidden", "false");
}

function closeResultModal() {
  elements.resultModal.hidden = true;
  elements.resultModal.setAttribute("aria-hidden", "true");
  scheduleLiveResume();
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape" && !elements.resultModal.hidden) {
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

window.addEventListener("beforeunload", () => {
  if (scanner && isRunning) {
    scanner.stop().catch(() => {});
  }
});
