// Film-Geek trivia bank manager — vanilla JS, no build step.
// General movie-knowledge questions live in Firestore (triviaBank/{id}),
// independent of any clip. host/app.js draws from this pool (alongside a
// clip's own authored trivia, if it has any) for bonus-trivia rounds. This
// page is purely content management — the host never writes here.

import { db, authReady } from "../shared/firebase.js";
import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const els = {
  triviaCount: document.getElementById("trivia-count"),
  exportBtn: document.getElementById("export-trivia-btn"),
  importInput: document.getElementById("import-trivia-input"),
  deleteAllBtn: document.getElementById("delete-all-btn"),

  formHeading: document.getElementById("trivia-form-heading"),
  questionInput: document.getElementById("tb-question-input"),
  categoryInput: document.getElementById("tb-category-input"),
  optInputs: [0, 1, 2, 3].map((i) => document.getElementById(`tb-opt-${i}`)),
  correctSelect: document.getElementById("tb-correct-select"),
  saveBtn: document.getElementById("tb-save-btn"),
  cancelBtn: document.getElementById("tb-cancel-btn"),

  filterInput: document.getElementById("tb-filter-input"),
  tableBody: document.getElementById("trivia-table-body"),
};

let questions = []; // live-synced from Firestore, each entry carries its own .id
let editingId = null; // null = adding new, otherwise the Firestore doc id being edited

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ---------- Load / sync ----------

async function loadQuestions() {
  const snap = await getDocs(collection(db, "triviaBank"));
  questions = [];
  snap.forEach((d) => questions.push({ id: d.id, ...d.data() }));
  questions.sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.question.localeCompare(b.question));
  renderTable();
}

// ---------- Form ----------

function resetForm() {
  editingId = null;
  els.formHeading.textContent = "Add a question";
  els.questionInput.value = "";
  els.categoryInput.value = "";
  els.optInputs.forEach((input) => (input.value = ""));
  els.correctSelect.value = "0";
  els.cancelBtn.hidden = true;
}

function loadIntoForm(q) {
  editingId = q.id;
  els.formHeading.textContent = `Editing — ${q.id}`;
  els.questionInput.value = q.question;
  els.categoryInput.value = q.category || "";
  q.options.forEach((opt, i) => (els.optInputs[i].value = opt));
  els.correctSelect.value = String(q.correctIndex);
  els.cancelBtn.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

els.cancelBtn.addEventListener("click", resetForm);

els.saveBtn.addEventListener("click", async () => {
  const question = els.questionInput.value.trim();
  const category = els.categoryInput.value.trim();
  const options = els.optInputs.map((input) => input.value.trim());
  if (!question || options.some((o) => !o)) {
    alert("Fill in the question and all 4 options first.");
    return;
  }

  const id = editingId || `${slugify(question)}-${Date.now().toString(36)}`;
  const entry = { question, category, options, correctIndex: Number(els.correctSelect.value) };

  els.saveBtn.disabled = true;
  try {
    await setDoc(doc(db, "triviaBank", id), entry);
    resetForm();
    await loadQuestions();
  } catch (err) {
    alert(`Couldn't save: ${err.message}`);
  } finally {
    els.saveBtn.disabled = false;
  }
});

// ---------- Table ----------

function renderTable() {
  els.triviaCount.textContent = `(${questions.length})`;
  const filter = els.filterInput.value.trim().toLowerCase();
  const filtered = filter
    ? questions.filter((q) => q.question.toLowerCase().includes(filter) || (q.category || "").toLowerCase().includes(filter))
    : questions;

  els.tableBody.innerHTML = "";
  filtered.forEach((q) => {
    const tr = document.createElement("tr");

    const catTd = document.createElement("td");
    catTd.textContent = q.category || "";
    tr.appendChild(catTd);

    const qTd = document.createElement("td");
    qTd.textContent = q.question;
    tr.appendChild(qTd);

    const ansTd = document.createElement("td");
    ansTd.textContent = q.options?.[q.correctIndex] ?? "";
    ansTd.className = "badge-yes";
    tr.appendChild(ansTd);

    const actionsTd = document.createElement("td");
    actionsTd.className = "actions";
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => loadIntoForm(q));
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteQuestion(q));
    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(deleteBtn);
    tr.appendChild(actionsTd);

    els.tableBody.appendChild(tr);
  });
}

els.filterInput.addEventListener("input", renderTable);

async function deleteQuestion(q) {
  if (!confirm(`Delete this question?\n\n"${q.question}"`)) return;
  try {
    await deleteDoc(doc(db, "triviaBank", q.id));
    await loadQuestions();
  } catch (err) {
    alert(`Couldn't delete: ${err.message}`);
  }
}

// ---------- Bulk: export / import / delete all ----------

els.exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(questions, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "filmgeek-trivia-bank.json";
  a.click();
  URL.revokeObjectURL(url);
});

els.importInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error("Expected a JSON array of questions.");

    for (const incoming of imported) {
      const id = incoming.id || `${slugify(incoming.question)}-${Date.now().toString(36)}`;
      const { id: _drop, ...entry } = incoming;
      void _drop;
      await setDoc(doc(db, "triviaBank", id), entry);
    }
    await loadQuestions();
    alert(`Imported ${imported.length} question(s).`);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

els.deleteAllBtn.addEventListener("click", async () => {
  if (questions.length === 0) return;
  if (!confirm(`Delete all ${questions.length} trivia questions? This can't be undone — export a backup first if you want one.`)) return;
  els.deleteAllBtn.disabled = true;
  try {
    await Promise.all(questions.map((q) => deleteDoc(doc(db, "triviaBank", q.id))));
    await loadQuestions();
  } catch (err) {
    alert(`Couldn't delete all: ${err.message}`);
  } finally {
    els.deleteAllBtn.disabled = false;
  }
});

// ---------- Init ----------

await authReady;
await loadQuestions();
