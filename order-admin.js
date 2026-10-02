const fs = require("node:fs");
const path = require("node:path");

const STATUSES = ["OPEN", "IN_PROGRESS", "READY_TO_SHIP", "SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED", "TRACKING_ISSUE", "CANCELED"];
const OPEN_STATUSES = ["OPEN", "IN_PROGRESS", "READY_TO_SHIP"];

function createAdminStore(filePath) {
  // Fail visibly on corrupt data instead of silently discarding overrides.
  let state = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
  if (!state || Array.isArray(state) || typeof state !== "object") throw new Error("Invalid order admin data");

  function get(id) {
    return state[String(id)] || {};
  }

  function update(id, body) {
    if (!/^\d+$/.test(String(id))) throw Object.assign(new Error("Invalid order ID"), { status: 400 });
    const next = { ...get(id) };
    switch (body?.action) {
      case "status":
        if (!STATUSES.includes(body.status)) throw Object.assign(new Error("Invalid status"), { status: 400 });
        next.status = body.status;
        next.statusUpdatedAt = new Date().toISOString();
        break;
      case "reset-status":
        delete next.status;
        delete next.statusUpdatedAt;
        break;
      case "note":
        if (typeof body.note !== "string" || body.note.length > 2000) {
          throw Object.assign(new Error("Notes must be 2,000 characters or less"), { status: 400 });
        }
        next.note = body.note.trim();
        break;
      case "clear": next.visibility = "cleared"; break;
      case "delete": next.visibility = "deleted"; break;
      case "restore": next.visibility = "visible"; break;
      default: throw Object.assign(new Error("Unknown order action"), { status: 400 });
    }
    next.updatedAt = new Date().toISOString();
    const updated = { ...state, [String(id)]: next };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    state = updated;
    return { ...next };
  }

  return { get, update };
}

function applyAdmin(order, admin) {
  return {
    ...order,
    sourceStatus: order.status,
    sourceOrder: {
      status: order.status, isOpen: order.isOpen, isCanceled: order.isCanceled,
      deliveredAt: order.deliveredAt, trackingStatusDate: order.trackingStatusDate
    },
    ...(admin.status ? {
      status: admin.status,
      isOpen: OPEN_STATUSES.includes(admin.status),
      isCanceled: admin.status === "CANCELED",
      deliveredAt: admin.status === "DELIVERED" ? order.deliveredAt || admin.statusUpdatedAt : null,
      trackingStatusDate: admin.statusUpdatedAt
    } : {}),
    admin: { ...admin }
  };
}

function transactionVariations(transaction) {
  if (!Array.isArray(transaction.variations)) return [];
  return transaction.variations
    .filter((variation) => variation && (variation.formatted_value ?? variation.value) != null)
    .map((variation) => ({
      name: String(variation.formatted_name || variation.name || "Option"),
      value: String(variation.formatted_value ?? variation.value)
    }));
}

module.exports = { STATUSES, createAdminStore, applyAdmin, transactionVariations };
