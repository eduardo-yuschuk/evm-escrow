// Lists the escrows of the API, one below the other, a page at a time. nginx proxies /api/ to the
// API, so the requests are same-origin.
const API = "api";
const PAGE_SIZE = 20;

const STATUS_LABELS = {
  Pending: "Pendiente",
  ExpiredRecoverable: "Vencido, recuperable",
  Released: "Liberado",
  Rejected: "Rechazado",
  CancelledBySender: "Cancelado por el sender",
  Expired: "Vencido, recuperado",
};

const ACTIONS = [
  ["canCancel", "cancelar"],
  ["canConfirm", "confirmar"],
  ["canReject", "rechazar"],
  ["canRecover", "recuperar"],
];

const $ = (id) => document.getElementById(id);
let offset = 0;

async function getJson(path) {
  const response = await fetch(`${API}${path}`);
  const body = await response.json().catch(() => null);
  // /health answers 503 with a body while degraded: that is still an answer.
  if (!response.ok && !(path === "/health" && body)) {
    throw new Error(body?.message ?? `HTTP ${response.status}`);
  }
  return body;
}

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Unix seconds, in the browser's time zone. */
const formatTime = (seconds) => (seconds === null ? "—" : new Date(seconds * 1000).toLocaleString());

function row(label, value, { mono = false } = {}) {
  return [element("dt", { textContent: label }), element("dd", { textContent: value, className: mono ? "mono" : "" })];
}

function renderEscrow(escrow) {
  const actions = ACTIONS.filter(([flag]) => escrow[flag]).map(([, name]) => name);
  const header = element("header", {}, [
    element("h2", { textContent: `#${escrow.id}` }),
    element("span", { className: `badge ${escrow.status}`, textContent: STATUS_LABELS[escrow.status] ?? escrow.status }),
  ]);
  const details = element("dl", {}, [
    ...row("Sender", escrow.sender, { mono: true }),
    ...row("Beneficiario", escrow.beneficiary, { mono: true }),
    ...row("Token", escrow.token, { mono: true }),
    // In the token's base units: the API does not know its decimals.
    ...row("Monto", escrow.amount, { mono: true }),
    ...row("Creado", formatTime(escrow.createdAt)),
    ...row("Cancelable hasta", formatTime(escrow.cancelDeadline)),
    ...row("Vence", formatTime(escrow.expiresAt)),
    ...row("Estado on-chain", escrow.onchainStatus),
    ...row("Acciones posibles", actions.length > 0 ? actions.join(", ") : "ninguna"),
    ...row("Tx de creación", escrow.createdTx, { mono: true }),
    ...row("Tx de resolución", escrow.resolvedTx ?? "—", { mono: true }),
    ...row("Resuelto", formatTime(escrow.resolvedAt)),
  ]);
  return element("li", { className: "escrow" }, [header, details]);
}

async function loadHealth() {
  try {
    const health = await getJson("/health");
    const state = health.status === "ok" ? "al día" : "atrasado";
    $("health").textContent =
      `Indexer ${state}: bloque ${health.lastIndexedBlock ?? "—"} de ${health.chainHead ?? "—"} (lag ${health.lag ?? "—"})`;
    $("health").className = health.status === "ok" ? "muted" : "warning";
  } catch (error) {
    $("health").textContent = `No se pudo consultar /health: ${error.message}`;
    $("health").className = "error";
  }
}

async function loadEscrows() {
  $("error").hidden = true;
  try {
    const page = await getJson(`/escrows?limit=${PAGE_SIZE}&offset=${offset}`);
    $("escrows").replaceChildren(...page.items.map(renderEscrow));
    $("escrows").start = offset + 1;
    $("summary").textContent =
      page.total === 0
        ? "No hay escrows indexados."
        : `${offset + 1}–${offset + page.items.length} de ${page.total}`;
    $("prev").disabled = offset === 0;
    $("next").disabled = offset + page.items.length >= page.total;
  } catch (error) {
    $("escrows").replaceChildren();
    $("summary").textContent = "";
    $("error").textContent = `No se pudo cargar la lista: ${error.message}`;
    $("error").hidden = false;
  }
}

function refresh() {
  return Promise.all([loadHealth(), loadEscrows()]);
}

$("refresh").addEventListener("click", refresh);
$("prev").addEventListener("click", () => {
  offset = Math.max(0, offset - PAGE_SIZE);
  loadEscrows();
});
$("next").addEventListener("click", () => {
  offset += PAGE_SIZE;
  loadEscrows();
});

refresh();
