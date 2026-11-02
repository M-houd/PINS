// ============================================================
// COFFRE — Portefeuille virtuel de documents
// Connecte le frontend statique au backend Flask (/api/...)
// ============================================================

const API_BASE = "http://localhost:5000/api";

const DOCUMENT_TYPES = [
  { key: "cni", label: "Carte d'identité nationale", short: "CNI" },
  { key: "passeport", label: "Passeport", short: "PASS" },
  { key: "permis_conduire", label: "Permis de conduire", short: "PERMIS" },
  { key: "carte_grise", label: "Carte grise", short: "CG" },
];

let currentUser = null;   // { id, username, email, full_name }
let documentsByType = {}; // { cni: {...} | undefined, ... }
let activeScanType = null;
let activeViewerDoc = null;

// ------------------------------------------------------------------
// Utilitaires
// ------------------------------------------------------------------
function $(selector, root = document) {
  return root.querySelector(selector);
}
function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}
function setError(scope, message) {
  const el = $(`.form-error[data-error-for="${scope}"]`);
  if (el) el.textContent = message || "";
}
async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  let body = null;
  try { body = await response.json(); } catch (_) { /* pas de corps JSON */ }
  if (!response.ok) {
    throw new Error((body && body.error) || `Erreur (${response.status})`);
  }
  return body;
}

// ------------------------------------------------------------------
// Auth : bascule d'onglet
// ------------------------------------------------------------------
$all(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $all(".tab").forEach((t) => t.classList.remove("tab--active"));
    tab.classList.add("tab--active");
    const target = tab.dataset.tab;
    $("#login-form").hidden = target !== "login";
    $("#register-form").hidden = target !== "register";
    setError("login", "");
    setError("register", "");
  });
});

// ------------------------------------------------------------------
// Auth : connexion
// ------------------------------------------------------------------
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("login", "");
  const form = new FormData(e.target);
  try {
    const user = await apiRequest("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.get("identifier"),
        email: form.get("identifier"),
        password: form.get("password"),
      }),
    });
    enterWallet(user);
  } catch (err) {
    setError("login", err.message);
  }
});

// ------------------------------------------------------------------
// Auth : inscription
// ------------------------------------------------------------------
$("#register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("register", "");
  const form = new FormData(e.target);
  try {
    const user = await apiRequest("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        email: form.get("email"),
        password: form.get("password"),
        full_name: form.get("full_name"),
      }),
    });
    enterWallet(user);
  } catch (err) {
    setError("register", err.message);
  }
});

$("#logout-btn").addEventListener("click", () => {
  currentUser = null;
  documentsByType = {};
  $("#wallet-screen").hidden = true;
  $("#auth-screen").hidden = false;
});

function enterWallet(user) {
  currentUser = user;
  $("#auth-screen").hidden = true;
  $("#wallet-screen").hidden = false;
  $("#user-display-name").textContent = user.full_name || user.username;
  loadDocuments();
}

// ------------------------------------------------------------------
// Chargement + rendu des cartes de documents
// ------------------------------------------------------------------
async function loadDocuments() {
  try {
    const docs = await apiRequest(`/documents?user_id=${currentUser.id}`);
    documentsByType = {};
    docs.forEach((d) => { documentsByType[d.document_type] = d; });
    renderCardGrid();
  } catch (err) {
    console.error("Erreur de chargement des documents :", err.message);
  }
}

function renderCardGrid() {
  const grid = $("#card-grid");
  grid.innerHTML = "";

  DOCUMENT_TYPES.forEach((type) => {
    const doc = documentsByType[type.key];
    const card = document.createElement("div");
    card.className = "doc-card " + (doc ? "doc-card--filled" : "doc-card--empty");

    if (doc && doc.signed_url) {
      if ((doc.mime_type || "").includes("pdf")) {
        card.style.background = "var(--bg-card)";
      } else {
        card.style.backgroundImage = `url("${doc.signed_url}")`;
      }
      card.innerHTML = `
        <span class="doc-card__seal">${type.short}</span>
        <div class="doc-card__overlay">
          <span class="doc-card__overlay-label">${type.label}</span>
          <span class="doc-card__overlay-sub">MAJ ${formatDate(doc.uploaded_at)}</span>
        </div>
      `;
      card.addEventListener("click", () => openViewer(type, doc));
    } else {
      card.innerHTML = `
        <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="10" width="40" height="30" rx="3" stroke="currentColor" stroke-width="2"/>
          <circle cx="24" cy="25" r="8" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span class="doc-card__label">${type.label}</span>
        <span class="doc-card__hint">Cliquez pour scanner</span>
      `;
      card.addEventListener("click", () => openScanModal(type));
    }

    grid.appendChild(card);
  });
}

function formatDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ------------------------------------------------------------------
// Modale : visualiser un document existant
// ------------------------------------------------------------------
function openViewer(type, doc) {
  activeViewerDoc = { type, doc };
  const frame = $("#modal-doc-frame");
  frame.innerHTML = (doc.mime_type || "").includes("pdf")
    ? `<iframe src="${doc.signed_url}" style="width:100%;height:340px;border:none;"></iframe>`
    : `<img src="${doc.signed_url}" alt="${type.label}">`;

  $("#modal-doc-meta").innerHTML = `
    <div><strong>${type.label}</strong></div>
    ${doc.document_number ? `<div>Numéro : ${escapeHtml(doc.document_number)}</div>` : ""}
    ${doc.issue_date ? `<div>Délivré le : ${formatDate(doc.issue_date)}</div>` : ""}
    ${doc.expiry_date ? `<div>Expire le : ${formatDate(doc.expiry_date)}</div>` : ""}
    <div>Scanné le ${formatDate(doc.uploaded_at)}</div>
  `;
  $("#viewer-modal").hidden = false;
}

$("#rescan-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !activeViewerDoc) return;
  await uploadDocument(activeViewerDoc.type, file, {});
  $("#viewer-modal").hidden = true;
});

$("#delete-doc-btn").addEventListener("click", async () => {
  if (!activeViewerDoc) return;
  if (!confirm("Supprimer ce document du portefeuille ?")) return;
  try {
    await apiRequest(`/documents/${activeViewerDoc.doc.id}?user_id=${currentUser.id}`, {
      method: "DELETE",
    });
    $("#viewer-modal").hidden = true;
    loadDocuments();
  } catch (err) {
    alert("Erreur lors de la suppression : " + err.message);
  }
});

// ------------------------------------------------------------------
// Modale : scanner un nouveau document
// ------------------------------------------------------------------
function openScanModal(type) {
  activeScanType = type;
  $("#scan-modal-title").textContent = `Scanner : ${type.label}`;
  $("#scan-input").value = "";
  $("#scan-preview").hidden = true;
  $("#scan-document-number").value = "";
  $("#scan-issue-date").value = "";
  $("#scan-expiry-date").value = "";
  setError("scan", "");
  $("#scan-modal").hidden = false;
}

$("#dropzone").addEventListener("click", () => $("#scan-input").click());
$("#scan-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.type.startsWith("image/")) {
    const reader = new FileReader();
    reader.onload = () => {
      $("#scan-preview-img").src = reader.result;
      $("#scan-preview").hidden = false;
    };
    reader.readAsDataURL(file);
  } else {
    $("#scan-preview").hidden = true;
  }
});

$("#scan-submit-btn").addEventListener("click", async () => {
  const file = $("#scan-input").files[0];
  setError("scan", "");
  if (!file) {
    setError("scan", "Choisissez un fichier à scanner.");
    return;
  }
  try {
    await uploadDocument(activeScanType, file, {
      document_number: $("#scan-document-number").value,
      issue_date: $("#scan-issue-date").value,
      expiry_date: $("#scan-expiry-date").value,
    });
    $("#scan-modal").hidden = true;
  } catch (err) {
    setError("scan", err.message);
  }
});

async function uploadDocument(type, file, meta) {
  const formData = new FormData();
  formData.append("user_id", currentUser.id);
  formData.append("document_type", type.key);
  formData.append("file", file);
  if (meta.document_number) formData.append("document_number", meta.document_number);
  if (meta.issue_date) formData.append("issue_date", meta.issue_date);
  if (meta.expiry_date) formData.append("expiry_date", meta.expiry_date);

  await apiRequest("/documents", { method: "POST", body: formData });
  await loadDocuments();
}

// ------------------------------------------------------------------
// Fermeture des modales
// ------------------------------------------------------------------
$all("[data-close-modal]").forEach((el) => {
  el.addEventListener("click", () => {
    $("#viewer-modal").hidden = true;
    $("#scan-modal").hidden = true;
  });
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
