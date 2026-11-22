function getTodayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getCurrentMonthISO() {
  return getTodayISO().slice(0, 7);
}

const HINDI_DAYS = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
const ENGLISH_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function getDayNameFromISO(dateStr, lang = "hi") {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return "";
  return lang === "en" ? ENGLISH_DAYS[dt.getDay()] : HINDI_DAYS[dt.getDay()];
}

function escapeCsvCell(val) {
  const str = String(val ?? "");
  return `"${str.replace(/"/g, '""')}"`;
}

function downloadExcelCsv(filename, headers, rows) {
  const bom = "\uFEFF";
  const csvLines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((r) => r.map(escapeCsvCell).join(","))
  ];
  const blob = new Blob([bom + csvLines.join("\r\n")], {
    type: "text/csv;charset=utf-8;"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await auth.signOut();
      window.location.href = "index.html";
    });
  }

  auth.onAuthStateChanged((user) => {
    if (page === "login") {
      if (user) {
        window.location.href = "home.html";
      }
      return;
    }

    if (!user) {
      window.location.href = "index.html";
      return;
    }

    if (page === "home") {
      initHomePage(user);
    } else if (page === "attendance") {
      initAttendancePage();
    } else if (page === "mdm") {
      initMdmPage();
    }
  });

  if (page === "login") {
    const loginForm = document.getElementById("login-form");
    const loginError = document.getElementById("login-error");

    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginError.textContent = "";
      const email = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value;

      try {
        await auth.signInWithEmailAndPassword(email, password);
        window.location.href = "home.html";
      } catch (err) {
        loginError.textContent = "लॉगिन असफल: ईमेल या पासवर्ड जांचें।";
      }
    });
  }
});

// ==================== HOME PAGE ====================
async function initHomePage(user) {
  const badge = document.getElementById("user-email-badge");
  if (badge) badge.textContent = `लॉगिन: ${user.email}`;

  const today = getTodayISO();

  try {
    const attDoc = await db.collection("attendance").doc(today).get();
    const attData = attDoc.exists ? attDoc.data() : { students: [], cooks: [] };
    document.getElementById("dash-students-count").textContent = String((attData.students || []).length);
    document.getElementById("dash-cooks-count").textContent = `${(attData.cooks || []).length} / 4`;

    const mdmDoc = await db.collection("mdm_logs").doc(today).get();
    const mdmData = mdmDoc.exists ? mdmDoc.data() : { count1To5: 0, count6To8: 0 };
    const totalMdm = Number(mdmData.count1To5 || 0) + Number(mdmData.count6To8 || 0);
    document.getElementById("dash-mdm-count").textContent = String(totalMdm);
  } catch (err) {
    console.error("Home stats error:", err);
  }
}

// ==================== ATTENDANCE PAGE ====================
function initAttendancePage() {
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";

  const attVideo = document.getElementById("att-video");
  const attOverlay = document.getElementById("att-overlay");
  const cameraModeLabel = document.getElementById("camera-mode-label");
  const cameraFeedback = document.getElementById("camera-feedback");
  const stopAttCamBtn = document.getElementById("stop-camera-btn");
  const regStatusMsg = document.getElementById("reg-status-msg");

  const modalBackdrop = document.getElementById("add-person-modal");
  const modalHeading = document.getElementById("modal-heading");
  const closeModalBtn = document.getElementById("close-modal-btn");
  const studentForm = document.getElementById("modal-student-form");
  const cookForm = document.getElementById("modal-cook-form");
  const modalFeedback = document.getElementById("modal-feedback");
  const modalVideo = document.getElementById("modal-video");
  const modalOverlay = document.getElementById("modal-overlay");

  const excelDateInput = document.getElementById("excel-date-input");
  const filterSelect = document.getElementById("report-filter-select");
  const reportTbody = document.getElementById("attendance-report-tbody");

  let modelsLoaded = false;
  let attStream = null;
  let modalStream = null;
  let scanInterval = null;
  let modalMode = null; // "student" | "cook"

  let studentsCache = [];
  let cooksCache = [];
  let presentStudentIds = new Set();
  let presentCookIds = new Set();

  const today = getTodayISO();
  excelDateInput.value = today;

  async function loadModels() {
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      modelsLoaded = true;
    } catch (err) {
      cameraFeedback.textContent = "फेस मॉडल लोड करने में समस्या आई।";
      console.error(err);
    }
  }

  async function loadMasterAndAttendance(targetDate = today) {
    const [stuSnap, cookSnap, attDoc] = await Promise.all([
      db.collection("students").get(),
      db.collection("cooks").get(),
      db.collection("attendance").doc(targetDate).get()
    ]);

    studentsCache = stuSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      descriptor: new Float32Array(doc.data().descriptor)
    }));

    cooksCache = cookSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      descriptor: new Float32Array(doc.data().descriptor)
    }));

    const attData = attDoc.exists ? attDoc.data() : { students: [], cooks: [] };
    presentStudentIds = new Set(attData.students || []);
    presentCookIds = new Set(attData.cooks || []);

    renderCountsAndTable(targetDate);
  }

  function getCombinedReportRows(targetDate) {
    const sortedStudents = [...studentsCache].sort((a, b) => {
      const cDiff = Number(a.class) - Number(b.class);
      if (cDiff !== 0) return cDiff;
      return Number(a.rollNo || 0) - Number(b.rollNo || 0);
    });

    const studentRows = sortedStudents.map((s) => ({
      category: "बच्चा",
      name: s.name || "",
      fatherName: s.fatherName || "-",
      className: s.class ? `कक्षा ${s.class}` : "-",
      rollNo: s.rollNo || "-",
      date: targetDate,
      status: presentStudentIds.has(s.id) ? "Present" : "Absent"
    }));

    const cookRows = cooksCache.map((c) => ({
      category: "रसोइया",
      name: c.name || "",
      fatherName: "-",
      className: "-",
      rollNo: "-",
      date: targetDate,
      status: presentCookIds.has(c.id) ? "Present" : "Absent"
    }));

    return [...studentRows, ...cookRows];
  }

  function renderCountsAndTable(targetDate = excelDateInput.value || today) {
    document.getElementById("total-students-count").textContent = String(studentsCache.length);
    document.getElementById("present-students-count").textContent = String(presentStudentIds.size);
    document.getElementById("total-cooks-count").textContent = String(cooksCache.length);
    document.getElementById("present-cooks-count").textContent = String(presentCookIds.size);

    const statusFilter = filterSelect ? filterSelect.value : "all";
    const rows = getCombinedReportRows(targetDate).filter((r) =>
      statusFilter === "all" ? true : r.status === statusFilter
    );

    if (!rows.length) {
      reportTbody.innerHTML = `<tr><td colspan="8" class="hint">कोई रिकॉर्ड उपलब्ध नहीं है। ऊपर से बच्चा या रसोइया ऐड करें।</td></tr>`;
      return;
    }

    reportTbody.innerHTML = "";
    rows.forEach((r, idx) => {
      const badgeClass = r.status === "Present" ? "badge-present" : "badge-absent";
      const badgeText = r.status === "Present" ? "उपस्थित" : "अनुपस्थित";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${r.category}</td>
        <td>${r.name}</td>
        <td>${r.fatherName}</td>
        <td>${r.className}</td>
        <td>${r.rollNo}</td>
        <td>${r.date}</td>
        <td><span class="${badgeClass}">${badgeText}</span></td>
      `;
      reportTbody.appendChild(tr);
    });
  }

  // ---- उपस्थिति कैमरा ----
  function stopAttendanceCamera() {
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }
    if (attStream) {
      attStream.getTracks().forEach((t) => t.stop());
      attStream = null;
    }
    attVideo.srcObject = null;
    const ctx = attOverlay.getContext("2d");
    ctx.clearRect(0, 0, attOverlay.width, attOverlay.height);
    cameraModeLabel.textContent = "कैमरा तैयार है";
    stopAttCamBtn.classList.add("hidden");
  }

  async function startAttendanceCamera(mode, labelText) {
    if (!modelsLoaded) {
      cameraFeedback.textContent = "कृपया प्रतीक्षा करें, फेस मॉडल लोड हो रहे हैं...";
      return;
    }
    stopAttendanceCamera();
    cameraModeLabel.textContent = labelText;
    stopAttCamBtn.classList.remove("hidden");
    cameraFeedback.textContent = "कैमरा खुल रहा है...";

    try {
      attStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false
      });
      attVideo.srcObject = attStream;
      await attVideo.play();
      cameraFeedback.textContent = "चेहरे को कैमरे के सामने रखें।";
      startRecognitionLoop(mode);
    } catch (err) {
      cameraFeedback.textContent = "कैमरा अनुमति नहीं मिली या कैमरा उपलब्ध नहीं है।";
      console.error(err);
    }
  }

  function startRecognitionLoop(mode) {
    const candidates = mode === "student" ? studentsCache : cooksCache;
    if (!candidates.length) {
      cameraFeedback.textContent =
        mode === "student"
          ? "पहले 'बच्चों को ऐड करे' से बच्चा जोड़ें।"
          : "पहले 'रसोइए ऐड करे' से रसोइया जोड़ें।";
      return;
    }

    const labeledDescriptors = candidates.map(
      (item) => new faceapi.LabeledFaceDescriptors(item.id, [item.descriptor])
    );
    const matcher = new faceapi.FaceMatcher(labeledDescriptors, 0.55);

    scanInterval = setInterval(async () => {
      if (!attVideo.videoWidth || !attVideo.videoHeight) return;
      attOverlay.width = attVideo.videoWidth;
      attOverlay.height = attVideo.videoHeight;

      const detections = await faceapi
        .detectAllFaces(attVideo, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();

      const ctx = attOverlay.getContext("2d");
      ctx.clearRect(0, 0, attOverlay.width, attOverlay.height);

      const resized = faceapi.resizeResults(detections, {
        width: attOverlay.width,
        height: attOverlay.height
      });

      for (const det of resized) {
        const match = matcher.findBestMatch(det.descriptor);
        const box = det.detection.box;
        ctx.strokeStyle = match.label !== "unknown" ? "#16a34a" : "#dc2626";
        ctx.lineWidth = 3;
        ctx.strokeRect(box.x, box.y, box.width, box.height);

        if (match.label !== "unknown") {
          const person = candidates.find((p) => p.id === match.label);
          if (person) {
            await markAttendance(mode, person);
          }
        }
      }
    }, 900);
  }

  async function markAttendance(mode, person) {
    if (mode === "student") {
      if (presentStudentIds.has(person.id)) {
        cameraFeedback.textContent = `${person.name} (कक्षा ${person.class}) की उपस्थिति पहले ही दर्ज है।`;
        return;
      }
      presentStudentIds.add(person.id);
    } else {
      if (presentCookIds.has(person.id)) {
        cameraFeedback.textContent = `रसोइया ${person.name} की उपस्थिति पहले ही दर्ज है।`;
        return;
      }
      presentCookIds.add(person.id);
    }

    await db.collection("attendance").doc(today).set(
      {
        date: today,
        students: Array.from(presentStudentIds),
        cooks: Array.from(presentCookIds)
      },
      { merge: true }
    );

    cameraFeedback.textContent =
      mode === "student"
        ? `उपस्थित दर्ज: ${person.name} (कक्षा ${person.class})`
        : `रसोई उपस्थिति दर्ज: ${person.name}`;

    if (excelDateInput.value === today) {
      renderCountsAndTable(today);
    }
  }

  // ---- Pop-up Modal (बच्चों को ऐड करे / रसोइए ऐड करे) ----
  async function openAddModal(type) {
    if (!modelsLoaded) {
      alert("कृपया प्रतीक्षा करें, फेस मॉडल लोड हो रहे हैं...");
      return;
    }

    stopAttendanceCamera();
    modalMode = type;

    if (type === "student") {
      modalHeading.textContent = "बच्चों को ऐड करे";
      studentForm.classList.remove("hidden");
      cookForm.classList.add("hidden");
    } else {
      modalHeading.textContent = "रसोइए ऐड करे";
      cookForm.classList.remove("hidden");
      studentForm.classList.add("hidden");
    }

    modalFeedback.textContent = "कैमरा खुल रहा है...";
    modalBackdrop.classList.remove("hidden");

    if (modalStream) {
      modalStream.getTracks().forEach((t) => t.stop());
      modalStream = null;
    }

    try {
      modalStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false
      });
      modalVideo.srcObject = modalStream;
      await modalVideo.play();
      modalFeedback.textContent = "जानकारी भरें और कैमरे के सामने चेहरा रखकर सेव दबाएं।";
    } catch (err) {
      modalFeedback.textContent = "कैमरा नहीं खुल सका। ब्राउज़र में Camera Permission Allow करें।";
      console.error(err);
    }
  }

  function closeAddModal() {
    if (modalStream) {
      modalStream.getTracks().forEach((t) => t.stop());
      modalStream = null;
    }
    modalVideo.srcObject = null;
    const ctx = modalOverlay.getContext("2d");
    ctx.clearRect(0, 0, modalOverlay.width, modalOverlay.height);
    modalBackdrop.classList.add("hidden");
    modalMode = null;
  }

  async function captureFaceDescriptorFromModal() {
    if (!modalVideo.srcObject || !modalVideo.videoWidth) {
      throw new Error("कैमरा तैयार नहीं है।");
    }
    modalOverlay.width = modalVideo.videoWidth;
    modalOverlay.height = modalVideo.videoHeight;

    const detection = await faceapi
      .detectSingleFace(modalVideo, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      throw new Error("चेहरा स्पष्ट नहीं दिखा, सीधे कैमरे की ओर देखें।");
    }

    const ctx = modalOverlay.getContext("2d");
    ctx.clearRect(0, 0, modalOverlay.width, modalOverlay.height);
    const box = detection.detection.box;
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    return Array.from(detection.descriptor);
  }

  studentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("m-student-name").value.trim();
    const fatherName = document.getElementById("m-student-father").value.trim();
    const studentClass = document.getElementById("m-student-class").value;
    const rollNo = Number(document.getElementById("m-student-roll").value);

    try {
      modalFeedback.textContent = "चेहरा कैप्चर और सेव हो रहा है...";
      const descriptorArr = await captureFaceDescriptorFromModal();

      const docRef = await db.collection("students").add({
        name,
        fatherName,
        class: studentClass,
        rollNo,
        descriptor: descriptorArr
      });

      studentsCache.push({
        id: docRef.id,
        name,
        fatherName,
        class: studentClass,
        rollNo,
        descriptor: new Float32Array(descriptorArr)
      });

      studentForm.reset();
      renderCountsAndTable(excelDateInput.value || today);
      regStatusMsg.textContent = `बच्चा जुड़ गया: ${name} (कक्षा ${studentClass})`;
      closeAddModal();
    } catch (err) {
      modalFeedback.textContent = err.message;
    }
  });

  cookForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("m-cook-name").value.trim();

    try {
      modalFeedback.textContent = "चेहरा कैप्चर और सेव हो रहा है...";
      const descriptorArr = await captureFaceDescriptorFromModal();

      const docRef = await db.collection("cooks").add({
        name,
        descriptor: descriptorArr
      });

      cooksCache.push({
        id: docRef.id,
        name,
        descriptor: new Float32Array(descriptorArr)
      });

      cookForm.reset();
      renderCountsAndTable(excelDateInput.value || today);
      regStatusMsg.textContent = `रसोइया जुड़ गया: ${name}`;
      closeAddModal();
    } catch (err) {
      modalFeedback.textContent = err.message;
    }
  });

  // इवेंट लिसनर्स
  document.getElementById("start-student-att-btn").addEventListener("click", () => {
    startAttendanceCamera("student", "बच्चों की उपस्थिति स्कैन हो रही है");
  });

  document.getElementById("start-cook-att-btn").addEventListener("click", () => {
    startAttendanceCamera("cook", "रसोई की उपस्थिति स्कैन हो रही है");
  });

  stopAttCamBtn.addEventListener("click", stopAttendanceCamera);

  document.getElementById("open-add-student-btn").addEventListener("click", () => {
    openAddModal("student");
  });

  document.getElementById("open-add-cook-btn").addEventListener("click", () => {
    openAddModal("cook");
  });

  closeModalBtn.addEventListener("click", closeAddModal);

  excelDateInput.addEventListener("change", async () => {
    const selectedDate = excelDateInput.value || today;
    await loadMasterAndAttendance(selectedDate);
  });

  filterSelect.addEventListener("change", () => {
    renderCountsAndTable(excelDateInput.value || today);
  });

  document.getElementById("download-all-excel-btn").addEventListener("click", async () => {
    const selectedDate = excelDateInput.value || today;
    await loadMasterAndAttendance(selectedDate);
    const rows = getCombinedReportRows(selectedDate).map((r, i) => [
      i + 1,
      "GMS HARIPURA 1 TO 8",
      r.category,
      r.name,
      r.fatherName,
      r.className,
      r.rollNo,
      r.date,
      r.status
    ]);
    downloadExcelCsv(
      `GMS-Haripura-Attendance-${selectedDate}.csv`,
      ["Sr. No.", "School", "Category", "Name", "Father Name", "Class", "Roll No.", "Date", "Status"],
      rows
    );
  });

  loadModels();
  loadMasterAndAttendance(today);
}

// ==================== MDM PAGE & MONTHLY PDF REPORT ====================
function initMdmPage() {
  const dateInput = document.getElementById("mdm-date");
  const dayInput = document.getElementById("mdm-day");
  const menuInput = document.getElementById("mdm-menu");
  const count15Input = document.getElementById("mdm-count-1-5");
  const count68Input = document.getElementById("mdm-count-6-8");
  const mdmMsg = document.getElementById("mdm-msg");

  const monthInput = document.getElementById("report-month");
  const schoolNameInput = document.getElementById("school-name-input");
  const reportMsg = document.getElementById("report-msg");
  const tbody = document.getElementById("mdm-month-tbody");

  const today = getTodayISO();
  dateInput.value = today;
  dayInput.value = getDayNameFromISO(today, "hi");
  monthInput.
