// दिनांक व वार की सामान्य उपयोगिता फ़ंक्शंस
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

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;

  // लॉगआउट बटन (यदि मौजूद हो)
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await auth.signOut();
      window.location.href = "index.html";
    });
  }

  // Auth स्टेट जांच: बिना लॉगिन के protected पेज खुलने पर index.html पर भेजें
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

  // लॉगिन पेज हैंडलर
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

// ==================== ATTENDANCE PAGE (FACE AUTH) ====================
function initAttendancePage() {
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
  const statusBadge = document.getElementById("model-status");
  const video = document.getElementById("video");
  const overlay = document.getElementById("overlay");
  const cameraModeLabel = document.getElementById("camera-mode-label");
  const cameraFeedback = document.getElementById("camera-feedback");
  const stopCamBtn = document.getElementById("stop-camera-btn");

  let modelsLoaded = false;
  let stream = null;
  let scanInterval = null;
  let currentMode = null; // "student-att" | "cook-att" | "student-reg" | "cook-reg"

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

    const presentStuNames = studentsCache
      .filter((s) => presentStudentIds.has(s.id))
      .map((s) => `${s.name} (कक्षा ${s.class})`);
    document.getElementById("present-students-count").textContent = String(presentStuNames.length);
    const stuUl = document.getElementById("present-students-list");
    stuUl.innerHTML = "";
    presentStuNames.forEach((label) => {
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

  function stopCamera() {
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    currentMode = null;
    cameraModeLabel.textContent = "कैमरा बंद है";
    stopCamBtn.classList.add("hidden");
  }

  async function startCamera(mode, labelText) {
    if (!modelsLoaded) {
      cameraFeedback.textContent = "कृपया प्रतीक्षा करें, फेस मॉडल अभी लोड हो रहे हैं...";
      return;
    }
    stopCamera();
    currentMode = mode;
    cameraModeLabel.textContent = labelText;
    stopCamBtn.classList.remove("hidden");
    cameraFeedback.textContent = "कैमरा शुरू हो रहा है...";

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false
      });
      video.srcObject = stream;
      cameraFeedback.textContent = "चेहरे को कैमरे के सामने रखें।";

      if (mode === "student-att" || mode === "cook-att") {
        startRecognitionLoop(mode);
      }
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
      if (!video.videoWidth || !video.videoHeight) return;
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;

      const detections = await faceapi
        .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();

      const ctx = overlay.getContext("2d");
      ctx.clearRect(0, 0, overlay.width, overlay.height);

      const resized = faceapi.resizeResults(detections, {
        width: overlay.width,
        height: overlay.height
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
        cameraFeedback.textContent = `${person.name} (कक्षा ${person.class}) की उपस्थिति पहले ही दर्ज है।`;
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
      cameraFeedback.textContent = `उपस्थित दर्ज: ${person.name} (कक्षा ${person.class})`;
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

  async function captureSingleDescriptor() {
    if (!video.srcObject || !video.videoWidth) {
      throw new Error("पहले रजिस्ट्रेशन कैमरा खोलें।");
    }
    const detection = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      throw new Error("चेहरा स्पष्ट नहीं दिखा, कृपया सीधे कैमरे की ओर देखें और पुनः प्रयास करें।");
    }
    return Array.from(detection.descriptor);
  }

  stopCamBtn.addEventListener("click", stopCamera);

  document.getElementById("start-student-att-btn").addEventListener("click", () => {
    startCamera("student-att", "बच्चों की उपस्थिति स्कैन हो रही है");
  });

  document.getElementById("start-cook-att-btn").addEventListener("click", () => {
    startCamera("cook-att", "रसोइयों की उपस्थिति स्कैन हो रही है");
  });

  document.getElementById("open-student-reg-cam-btn").addEventListener("click", () => {
    startCamera("student-reg", "नया बच्चा रजिस्ट्रेशन कैमरा");
  });

  document.getElementById("open-cook-reg-cam-btn").addEventListener("click", () => {
    startCamera("cook-reg", "रसोइया रजिस्ट्रेशन कैमरा");
  });

  // बच्चा रजिस्ट्रेशन
  document.getElementById("register-student-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById("student-reg-msg");
    const name = document.getElementById("student-name").value.trim();
    const studentClass = document.getElementById("student-class").value;

    try {
      msgEl.textContent = "चेहरा स्कैन किया जा रहा है...";
      const descriptorArr = await captureSingleDescriptor();
      const docRef = await db.collection("students").add({
        name,
        class: studentClass,
        descriptor: descriptorArr
      });

      studentsCache.push({
        id: docRef.id,
        name,
        class: studentClass,
        descriptor: new Float32Array(descriptorArr)
      });

      e.target.reset();
      renderAttendanceUI();
      msgEl.textContent = `${name} (कक्षा ${studentClass}) सफलतापूर्वक रजिस्टर हो गया।`;
    } catch (err) {
      msgEl.textContent = err.message;
    }
  });

  // रसोइया रजिस्ट्रेशन (अधिकतम 4)
  document.getElementById("register-cook-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById("cook-reg-msg");
    const name = document.getElementById("cook-name").value.trim();

    if (cooksCache.length >= 4) {
      msgEl.textContent = "अधिकतम 4 रसोइए ही रजिस्टर किए जा सकते हैं।";
      return;
    }

    try {
      msgEl.textContent = "चेहरा स्कैन किया जा रहा है...";
      const descriptorArr = await captureSingleDescriptor();
      const docRef = await db.collection("cooks").add({
        name,
        descriptor: descriptorArr
      });

      cooksCache.push({
        id: docRef.id,
        name,
        descriptor: new Float32Array(descriptorArr)
      });

      e.target.reset();
      renderAttendanceUI();
      msgEl.textContent = `रसोइया ${name} सफलतापूर्वक रजिस्टर हो गए।`;
    } catch (err) {
      msgEl.textContent = err.message;
    }
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

  // दैनिक MDM एंट्री सेव करें
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
        total: count1To5 + count6To8,
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

  // मासिक PDF रिपोर्ट डाउनलोड (MDM प्रभारी के हस्ताक्षर सहित)
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

    const schoolTitle = schoolNameInput.value.trim() || "School MDM Monthly Report";
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

    // MDM प्रभारी के हस्ताक्षर का कॉलम
    doc.setFontSize(10);
    doc.text("_________________________", 14, sigY);
    doc.text("MDM Prabhari Signature", 14, sigY + 6);

    doc.save(`MDM-Report-${monthStr}.pdf`);
    reportMsg.textContent = `MDM-Report-${monthStr}.pdf डाउनलोड हो गई है।`;
  });

  loadMonthRecords(monthInput.value);
}
