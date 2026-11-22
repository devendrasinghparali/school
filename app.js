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
  const statusBadge = document.getElementById("model-status");

  // उपस्थिति कैमरा एलिमेंट्स
  const attVideo = document.getElementById("att-video");
  const attOverlay = document.getElementById("att-overlay");
  const cameraModeLabel = document.getElementById("camera-mode-label");
  const cameraFeedback = document.getElementById("camera-feedback");
  const stopAttCamBtn = document.getElementById("stop-camera-btn");

  // Pop-up कैमरा एलिमेंट्स
  const popupModal = document.getElementById("camera-popup-modal");
  const popupTitle = document.getElementById("popup-title");
  const popupVideo = document.getElementById("popup-video");
  const popupOverlay = document.getElementById("popup-overlay");
  const popupFeedback = document.getElementById("popup-feedback");
  const closePopupBtn = document.getElementById("close-popup-btn");
  const popupCaptureSaveBtn = document.getElementById("popup-capture-save-btn");

  let modelsLoaded = false;
  let attStream = null;
  let popupStream = null;
  let scanInterval = null;
  let popupTarget = null; // "student" | "cook"

  let studentsCache = [];
  let cooksCache = [];
  let presentStudentIds = new Set();
  let presentCookIds = new Set();

  const today = getTodayISO();

  async function loadModels() {
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      modelsLoaded = true;
      statusBadge.textContent = "फेस मॉडल तैयार है";
    } catch (err) {
      statusBadge.textContent = "फेस मॉडल लोड करने में समस्या";
      console.error(err);
    }
  }

  async function loadMasterAndAttendance() {
    const [stuSnap, cookSnap, attDoc] = await Promise.all([
      db.collection("students").get(),
      db.collection("cooks").get(),
      db.collection("attendance").doc(today).get()
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

    renderAttendanceUI();
  }

  function renderAttendanceUI() {
    document.getElementById("registered-students-count").textContent = String(studentsCache.length);
    document.getElementById("registered-cooks-count").textContent = String(cooksCache.length);

    const cookListEl = document.getElementById("registered-cooks-list");
    cookListEl.innerHTML = "";
    cooksCache.forEach((c) => {
      const li = document.createElement("li");
      li.textContent = c.name;
      cookListEl.appendChild(li);
    });

    const presentStuItems = studentsCache
      .filter((s) => presentStudentIds.has(s.id))
      .map((s) => `${s.name} (कक्षा ${s.class}, क्र. ${s.rollNo || "-"})`);
    document.getElementById("present-students-count").textContent = String(presentStuItems.length);
    const stuUl = document.getElementById("present-students-list");
    stuUl.innerHTML = "";
    presentStuItems.forEach((label) => {
      const li = document.createElement("li");
      li.textContent = label;
      stuUl.appendChild(li);
    });

    const presentCookNames = cooksCache
      .filter((c) => presentCookIds.has(c.id))
      .map((c) => c.name);
    document.getElementById("present-cooks-count").textContent = String(presentCookNames.length);
    const cookUl = document.getElementById("present-cooks-list");
    cookUl.innerHTML = "";
    presentCookNames.forEach((name) => {
      const li = document.createElement("li");
      li.textContent = name;
      cookUl.appendChild(li);
    });
  }

  // ---- उपस्थिति कैमरा कंट्रोल ----
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
    cameraModeLabel.textContent = "उपस्थिति कैमरा बंद है";
    stopAttCamBtn.classList.add("hidden");
  }

  async function startAttendanceCamera(mode, labelText) {
    if (!modelsLoaded) {
      cameraFeedback.textContent = "कृपया प्रतीक्षा करें, फेस मॉडल अभी लोड हो रहे हैं...";
      return;
    }
    stopAttendanceCamera();
    cameraModeLabel.textContent = labelText;
    stopAttCamBtn.classList.remove("hidden");
    cameraFeedback.textContent = "कैमरा शुरू हो रहा है...";

    try {
      attStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false
      });
      attVideo.srcObject = attStream;
      cameraFeedback.textContent = "चेहरे को कैमरे के सामने रखें।";
      startRecognitionLoop(mode);
    } catch (err) {
      cameraFeedback.textContent = "कैमरा अनुमति नहीं मिली या डिवाइस में कैमरा उपलब्ध नहीं है।";
      console.error(err);
    }
  }

  function startRecognitionLoop(mode) {
    const candidates = mode === "student-att" ? studentsCache : cooksCache;
    if (!candidates.length) {
      cameraFeedback.textContent = "पहले रजिस्ट्रेशन से कम से कम एक चेहरा सेव करें।";
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
            await markPresent(mode, person);
          }
        }
      }
    }, 900);
  }

  async function markPresent(mode, person) {
    if (mode === "student-att") {
      if (presentStudentIds.has(person.id)) {
        cameraFeedback.textContent = `${person.name} (कक्षा ${person.class}, क्र. ${person.rollNo || "-"}) की उपस्थिति पहले ही दर्ज है।`;
        return;
      }
      presentStudentIds.add(person.id);
      await db.collection("attendance").doc(today).set(
        {
          date: today,
          students: Array.from(presentStudentIds),
          cooks: Array.from(presentCookIds)
        },
        { merge: true }
      );
      cameraFeedback.textContent = `उपस्थित दर्ज: ${person.name} (कक्षा ${person.class}, क्र. ${person.rollNo || "-"})`;
    } else {
      if (presentCookIds.has(person.id)) {
        cameraFeedback.textContent = `रसोइया ${person.name} की उपस्थिति पहले ही दर्ज है।`;
        return;
      }
      presentCookIds.add(person.id);
      await db.collection("attendance").doc(today).set(
        {
          date: today,
          students: Array.from(presentStudentIds),
          cooks: Array.from(presentCookIds)
        },
        { merge: true }
      );
      cameraFeedback.textContent = `उपस्थित दर्ज (रसोइया): ${person.name}`;
    }
    renderAttendanceUI();
  }

  // ---- Pop-up कैमरा कंट्रोल ----
  async function openPopupCamera(target) {
    if (!modelsLoaded) {
      alert("कृपया प्रतीक्षा करें, फेस मॉडल अभी लोड हो रहे हैं...");
      return;
    }

    if (target === "student") {
      const name = document.getElementById("student-name").value.trim();
      const fatherName = document.getElementById("student-father").value.trim();
      const studentClass = document.getElementById("student-class").value;
      const rollNo = document.getElementById("student-roll").value;
      if (!name || !fatherName || !studentClass || !rollNo) {
        document.getElementById("student-reg-msg").textContent =
          "कृपया पहले बच्चे का नाम, पिता का नाम, कक्षा और क्रमांक भरें, फिर कैमरा Pop-up खोलें।";
        return;
      }
    } else if (target === "cook") {
      const cookName = document.getElementById("cook-name").value.trim();
      if (!cookName) {
        document.getElementById("cook-reg-msg").textContent = "कृपया पहले रसोइए का नाम लिखें।";
        return;
      }
      if (cooksCache.length >= 4) {
        document.getElementById("cook-reg-msg").textContent = "अधिकतम 4 रसोइए ही रजिस्टर किए जा सकते हैं।";
        return;
      }
    }

    popupTarget = target;
    popupTitle.textContent =
      target === "student" ? "नया बच्चा — चेहरा कैप्चर Pop-up" : "रसोइया — चेहरा कैप्चर Pop-up";
    popupFeedback.textContent = "कैमरा शुरू हो रहा है...";
    popupModal.classList.remove("hidden");

    try {
      popupStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false
      });
      popupVideo.srcObject = popupStream;
      popupFeedback.textContent = "चेहरे को कैमरे के सामने रखें और नीचे 'चेहरा कैप्चर और सेव करें' दबाएं।";
    } catch (err) {
      popupFeedback.textContent = "कैमरा शुरू नहीं हो सका। अनुमति जांचें।";
      console.error(err);
    }
  }

  function closePopupCamera() {
    if (popupStream) {
      popupStream.getTracks().forEach((t) => t.stop());
      popupStream = null;
    }
    popupVideo.srcObject = null;
    const ctx = popupOverlay.getContext("2d");
    ctx.clearRect(0, 0, popupOverlay.width, popupOverlay.height);
    popupModal.classList.add("hidden");
    popupTarget = null;
  }

  async function capturePopupDescriptor() {
    if (!popupVideo.srcObject || !popupVideo.videoWidth) {
      throw new Error("Pop-up कैमरा तैयार नहीं है।");
    }
    popupOverlay.width = popupVideo.videoWidth;
    popupOverlay.height = popupVideo.videoHeight;

    const detection = await faceapi
      .detectSingleFace(popupVideo, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      throw new Error("चेहरा स्पष्ट नहीं दिखा, सीधे कैमरे की ओर देखें।");
    }

    const ctx = popupOverlay.getContext("2d");
    ctx.clearRect(0, 0, popupOverlay.width, popupOverlay.height);
    const box = detection.detection.box;
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    return Array.from(detection.descriptor);
  }

  async function saveFromPopup() {
    try {
      popupFeedback.textContent = "चेहरा स्कैन और सेव किया जा रहा है...";
      const descriptorArr = await capturePopupDescriptor();

      if (popupTarget === "student") {
        const name = document.getElementById("student-name").value.trim();
        const fatherName = document.getElementById("student-father").value.trim();
        const studentClass = document.getElementById("student-class").value;
        const rollNo = Number(document.getElementById("student-roll").value);

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

        document.getElementById("register-student-form").reset();
        renderAttendanceUI();
        document.getElementById("student-reg-msg").textContent =
          `${name} (पिता: ${fatherName}, कक्षा ${studentClass}, क्र. ${rollNo}) सफलतापूर्वक सेव हो गया।`;
      } else if (popupTarget === "cook") {
        const name = document.getElementById("cook-name").value.trim();
        const docRef = await db.collection("cooks").add({
          name,
          descriptor: descriptorArr
        });

        cooksCache.push({
          id: docRef.id,
          name,
          descriptor: new Float32Array(descriptorArr)
        });

        document.getElementById("register-cook-form").reset();
        renderAttendanceUI();
        document.getElementById("cook-reg-msg").textContent = `रसोइया ${name} सफलतापूर्वक सेव हो गए।`;
      }

      closePopupCamera();
    } catch (err) {
      popupFeedback.textContent = err.message;
    }
  }

  stopAttCamBtn.addEventListener("click", stopAttendanceCamera);
  document.getElementById("start-student-att-btn").addEventListener("click", () => {
    startAttendanceCamera("student-att", "बच्चों की उपस्थिति स्कैन हो रही है");
  });
  document.getElementById("start-cook-att-btn").addEventListener("click", () => {
    startAttendanceCamera("cook-att", "रसोइयों की उपस्थिति स्कैन हो रही है");
  });

  document.getElementById("open-student-popup-btn").addEventListener("click", () => {
    openPopupCamera("student");
  });
  document.getElementById("register-student-form").addEventListener("submit", (e) => {
    e.preventDefault();
    openPopupCamera("student");
  });

  document.getElementById("open-cook-popup-btn").addEventListener("click", () => {
    openPopupCamera("cook");
  });
  document.getElementById("register-cook-form").addEventListener("submit", (e) => {
    e.preventDefault();
    openPopupCamera("cook");
  });

  closePopupBtn.addEventListener("click", closePopupCamera);
  popupCaptureSaveBtn.addEventListener("click", saveFromPopup);

  // ---- Date-wise Excel डाउनलोड ----
  const excelDateInput = document.getElementById("excel-date-input");
  if (excelDateInput) {
    excelDateInput.value = today;
  }

  async function fetchAttendanceSetsForDate(targetDate) {
    if (!targetDate || targetDate === today) {
      return {
        dateStr: today,
        studentSet: presentStudentIds,
        cookSet: presentCookIds
      };
    }
    const doc = await db.collection("attendance").doc(targetDate).get();
    const data = doc.exists ? doc.data() : { students: [], cooks: [] };
    return {
      dateStr: targetDate,
      studentSet: new Set(data.students || []),
      cookSet: new Set(data.cooks || [])
    };
  }

  function buildStudentRows(dateStr, studentSet) {
    const sorted = [...studentsCache].sort((a, b) => {
      const cDiff = Number(a.class) - Number(b.class);
      if (cDiff !== 0) return cDiff;
      return Number(a.rollNo || 0) - Number(b.rollNo || 0);
    });

    return sorted.map((s) => [
      "GMS HARIPURA 1 TO 8",
      dateStr,
      "Student",
      s.class,
      s.rollNo || "",
      s.name,
      s.fatherName || "",
      studentSet.has(s.id) ? "Present" : "Absent"
    ]);
  }

  function buildCookRows(dateStr, cookSet) {
    return cooksCache.map((c) => [
      "GMS HARIPURA 1 TO 8",
      dateStr,
      "Cook",
      "",
      "",
      c.name,
      "",
      cookSet.has(c.id) ? "Present" : "Absent"
    ]);
  }

  const excelHeaders = [
    "School",
    "Date",
    "Category",
    "Class",
    "Roll No.",
    "Name",
    "Father Name",
    "Attendance Status"
  ];

  document.getElementById("download-student-excel-btn").addEventListener("click", async () => {
    const chosenDate = (excelDateInput && excelDateInput.value) || today;
    const { dateStr, studentSet } = await fetchAttendanceSetsForDate(chosenDate);
    downloadExcelCsv(
      `GMS-Haripura-Students-Attendance-${dateStr}.csv`,
      excelHeaders,
      buildStudentRows(dateStr, studentSet)
    );
  });

  document.getElementById("download-cook-excel-btn").addEventListener("click", async () => {
    const chosenDate = (excelDateInput && excelDateInput.value) || today;
    const { dateStr, cookSet } = await fetchAttendanceSetsForDate(chosenDate);
    downloadExcelCsv(
      `GMS-Haripura-Cooks-Attendance-${dateStr}.csv`,
      excelHeaders,
      buildCookRows(dateStr, cookSet)
    );
  });

  document.getElementById("download-all-excel-btn").addEventListener("click", async () => {
    const chosenDate = (excelDateInput && excelDateInput.value) || today;
    const { dateStr, studentSet, cookSet } = await fetchAttendanceSetsForDate(chosenDate);
    downloadExcelCsv(
      `GMS-Haripura-Complete-Attendance-${dateStr}.csv`,
      excelHeaders,
      [...buildStudentRows(dateStr, studentSet), ...buildCookRows(dateStr, cookSet)]
    );
  });

  loadModels();
  loadMasterAndAttendance();
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
  monthInput.value = getCurrentMonthISO();

  dateInput.addEventListener("change", () => {
    dayInput.value = getDayNameFromISO(dateInput.value, "hi");
  });

  async function loadMonthRecords(monthStr) {
    tbody.innerHTML = `<tr><td colspan="6" class="hint">डेटा लोड हो रहा है...</td></tr>`;
    try {
      const snap = await db
        .collection("mdm_logs")
        .where("date", ">=", `${monthStr}-01`)
        .where("date", "<=", `${monthStr}-31`)
        .get();

      const rows = snap.docs
        .map((d) => d.data())
        .sort((a, b) => a.date.localeCompare(b.date));

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="hint">इस माह का कोई रिकॉर्ड नहीं मिला।</td></tr>`;
        return rows;
      }

      tbody.innerHTML = "";
      rows.forEach((r) => {
        const c15 = Number(r.count1To5 || 0);
        const c68 = Number(r.count6To8 || 0);
        const total = c15 + c68;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${r.date}</td>
          <td>${r.dayHi || getDayNameFromISO(r.date, "hi")}</td>
          <td>${r.menu || ""}</td>
          <td>${c15}</td>
          <td>${c68}</td>
          <td><strong>${total}</strong></td>
        `;
        tbody.appendChild(tr);
      });

      return rows;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="error-text">डेटा लोड करने में त्रुटि।</td></tr>`;
      console.error(err);
      return [];
    }
  }

  monthInput.addEventListener("change", () => {
    if (monthInput.value) {
      loadMonthRecords(monthInput.value);
    }
  });

  document.getElementById("mdm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    mdmMsg.textContent = "";

    const dateVal = dateInput.value;
    const dayHi = getDayNameFromISO(dateVal, "hi");
    const dayEn = getDayNameFromISO(dateVal, "en");
    const menuVal = menuInput.value.trim();
    const count1To5 = Number(count15Input.value || 0);
    const count6To8 = Number(count68Input.value || 0);

    try {
      await db.collection("mdm_logs").doc(dateVal).set({
        date: dateVal,
        dayHi,
        dayEn,
        menu: menuVal,
        count1To5,
        count6To8,
        total: count1To5 + count68,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      mdmMsg.textContent = `${dateVal} (${dayHi}) का MDM रिकॉर्ड सेव हो गया।`;
      if (dateVal.startsWith(monthInput.value)) {
        await loadMonthRecords(monthInput.value);
      }
    } catch (err) {
      mdmMsg.textContent = "रिकॉर्ड सेव करने में समस्या आई।";
      console.error(err);
    }
  });

  document.getElementById("download-mdm-pdf-btn").addEventListener("click", async () => {
    reportMsg.textContent = "";
    const monthStr = monthInput.value;
    if (!monthStr) {
      reportMsg.textContent = "कृपया माह चुनें।";
      return;
    }

    const records = await loadMonthRecords(monthStr);
    if (!records.length) {
      reportMsg.textContent = "चयनित माह में कोई MDM डेटा उपलब्ध नहीं है।";
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

    const schoolTitle = schoolNameInput.value.trim() || "GMS HARIPURA 1 TO 8";
    doc.setFontSize(14);
    doc.text(schoolTitle, 14, 16);
    doc.setFontSize(11);
    doc.text(`Monthly MDM Report - Month: ${monthStr}`, 14, 23);

    let sum1To5 = 0;
    let sum6To8 = 0;
    let sumTotal = 0;

    const tableBody = records.map((r) => {
      const c15 = Number(r.count1To5 || 0);
      const c68 = Number(r.count6To8 || 0);
      const tot = c15 + c68;
      sum1To5 += c15;
      sum6To8 += c68;
      sumTotal += tot;
      return [
        r.date,
        r.dayEn || getDayNameFromISO(r.date, "en"),
        r.menu || "",
        String(c15),
        String(c68),
        String(tot)
      ];
    });

    tableBody.push([
      "Total",
      "",
      "",
      String(sum1To5),
      String(sum6To8),
      String(sumTotal)
    ]);

    doc.autoTable({
      startY: 28,
      head: [["Date", "Day", "Menu", "Class 1-5", "Class 6-8", "Total"]],
      body: tableBody,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [30, 58, 138] }
    });

    const finalY = doc.lastAutoTable.finalY + 22;
    const pageHeight = doc.internal.pageSize.getHeight();
    const sigY = finalY > pageHeight - 25 ? pageHeight - 20 : finalY;

    doc.setFontSize(10);
    doc.text("_________________________", 14, sigY);
    doc.text("MDM Prabhari Signature", 14, sigY + 6);

    doc.save(`MDM-Report-${monthStr}.pdf`);
    reportMsg.textContent = `MDM-Report-${monthStr}.pdf डाउनलोड हो गई है।`;
  });

  loadMonthRecords(monthInput.value);
}
