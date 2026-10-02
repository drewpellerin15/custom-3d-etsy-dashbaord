let page = 0;
let activeFilter = "ALL";
let allOrders = [];
let lastUpdatedAt = null;
let sourceOrders = [];
let savingAdmin = false;
let loadVersion = 0;
let menuOrderId = null;
const statusLabels = {
  OPEN: "Open", IN_PROGRESS: "In progress", READY_TO_SHIP: "Ready to ship",
  SHIPPED: "Shipped", IN_TRANSIT: "In transit", DELIVERED: "Delivered",
  RETURNED: "Returned", TRACKING_ISSUE: "Tracking issue", CANCELED: "Canceled"
};

function applyOrderAdmin(order) {
  const admin = order.admin || {};
  return {
    ...order,
    ...(admin.status ? {
      status: admin.status,
      isOpen: ["OPEN", "IN_PROGRESS", "READY_TO_SHIP"].includes(admin.status),
      isCanceled: admin.status === "CANCELED",
      deliveredAt: admin.status === "DELIVERED" ? order.deliveredAt || admin.statusUpdatedAt : null,
      trackingStatusDate: admin.statusUpdatedAt
    } : {})
  };
}

function visibleOrders() {
  return allOrders.filter((order) => !["cleared", "deleted"].includes(order.admin?.visibility));
}

const pageSize = 8;
const placeholderImage =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 420 260'%3E%3Crect width='420' height='260' fill='%230b0f14'/%3E%3Cpath d='M78 176h264l-58-72-45 48-31-34-42 58Z' fill='%23202631'/%3E%3Ccircle cx='146' cy='91' r='27' fill='%23202631'/%3E%3C/svg%3E";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "--";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function formatMoney(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return escapeHtml(value);
  return number.toLocaleString(undefined, {
    style: "currency",
    currency: "USD"
  });
}

function formatClock(date = new Date()) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function formatCurrentDateTime(date = new Date()) {
  return `${date.toLocaleDateString([], {
    month: "short",
    day: "numeric"
  })}, ${formatClock(date)}`;
}

function parseDate(value) {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isThisMonth(value) {
  const date = parseDate(value);
  if (!date) return false;

  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

function isShipsSoon(order) {
  if (!order.isOpen || !order.shipBy) return false;

  const shipDate = new Date(`${order.shipBy}T23:59:59`);
  const now = new Date();
  const diff = shipDate.getTime() - now.getTime();

  return diff <= 2 * 24 * 60 * 60 * 1000;
}

function relativeStatus(order) {
  if (["IN_PROGRESS", "READY_TO_SHIP", "CANCELED"].includes(order.status)) {
    return { label: statusLabels[order.status], type: order.status };
  }
  if (order.status === "DELIVERED") {
    return { label: "Delivered", type: "DELIVERED" };
  }

  if (order.status === "IN_TRANSIT") {
    return { label: "In transit", type: "IN_TRANSIT" };
  }

  if (order.status === "RETURNED") {
    return { label: "Returned", type: "RETURNED" };
  }

  if (order.status === "TRACKING_ISSUE") {
    return { label: "Issue", type: "TRACKING_ISSUE" };
  }

  if (order.status === "SHIPPED") {
    return { label: "Shipped", type: "SHIPPED" };
  }

  if (isShipsSoon(order)) {
    return { label: "Ships soon", type: "SHIPS_SOON" };
  }

  return { label: "Open", type: "OPEN" };
}

function filteredOrders() {
  if (activeFilter === "HIDDEN") return allOrders.filter((order) => ["cleared", "deleted"].includes(order.admin?.visibility));
  const orders = visibleOrders();
  if (activeFilter === "ALL") return orders;
  if (activeFilter === "SHIPPED") {
    return orders.filter((order) =>
      ["SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED", "TRACKING_ISSUE"].includes(order.status)
    );
  }
  if (activeFilter === "OPEN") {
    return orders.filter((order) => order.isOpen);
  }
  return orders.filter((order) => order.status === activeFilter);
}

function updateSummary(data) {
  const monthOrders = data.filter((order) =>
    isThisMonth(order.trackingStatusDate || order.shippedAt || order.createdAt)
  );
  const shipped = monthOrders.filter((order) => order.status === "SHIPPED").length;
  const inTransit = monthOrders.filter((order) => order.status === "IN_TRANSIT").length;
  const delivered = monthOrders.filter((order) => order.status === "DELIVERED").length;
  const open = data.filter((order) => order.isOpen).length;
  const shipping = shipped + inTransit;
  const shipsSoon = data.filter(isShipsSoon).length;

  document.getElementById("summary").innerHTML = `
    <div class="summary-card">
      <span class="summary-label">Open</span>
      <strong>${open}</strong>
    </div>
    <div class="summary-card">
      <span class="summary-label">Ships soon</span>
      <strong>${shipsSoon}</strong>
    </div>
    <div class="summary-card">
      <span class="summary-label">Delivered</span>
      <strong>${delivered}</strong>
    </div>
    <div class="summary-card">
      <span class="summary-label">Shipping</span>
      <strong>${shipping}</strong>
    </div>
  `;
}

function updateMeta(total, visibleTotal) {
  document.getElementById("current-time").textContent = formatCurrentDateTime();
  document.getElementById("order-count").textContent =
    activeFilter === "ALL" ? `${visibleTotal} orders` : `${visibleTotal} of ${total}`;
  document.getElementById("last-updated").textContent =
    `Updated ${lastUpdatedAt ? formatClock(lastUpdatedAt) : "--:--"}`;
}

function updatePagination(total) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (page > pageCount - 1) page = pageCount - 1;

  document.getElementById("prevBtn").disabled = page === 0;
  document.getElementById("nextBtn").disabled = page + 1 >= pageCount;
  document.getElementById("pageIndicator").textContent = `${page + 1} / ${pageCount}`;
}

function updateTabs() {
  document.querySelectorAll(".filter-tab").forEach((tab) => {
    const isActive = tab.dataset.filter === activeFilter;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
}

function buildCard(order) {
  const status = relativeStatus(order);
  const image = order.image || placeholderImage;
  const location = [order.city, order.state].filter(Boolean).join(", ");
  const transactionCount = Array.isArray(order.transactions) ? order.transactions.length : 0;
  const trackingDetails = order.trackingDetails ? escapeHtml(order.trackingDetails) : "";
  const deliveredDate = order.status === "DELIVERED"
    ? formatDate(order.deliveredAt)
    : null;
  const hasShipped = ["SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED", "TRACKING_ISSUE"].includes(order.status);
  const primaryDateLabel = hasShipped ? "Shipped on" : "Ship by";
  const primaryDateValue = hasShipped
    ? formatDate(order.shippedAt || order.shipBy)
    : formatDate(order.shipBy);
  const etsyUrl = order.etsyUrl ||
    `https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav&order_id=${encodeURIComponent(order.receiptId || order.id || "")}`;

  return `
    <article class="order-card" data-order-url="${escapeHtml(etsyUrl)}">
      <button class="order-menu-trigger" data-order-id="${escapeHtml(order.id)}" aria-label="Options for order ${escapeHtml(order.id)}" aria-haspopup="menu" aria-expanded="false">⋮</button>
      <div class="order-image">
        <img src="${escapeHtml(image)}" alt="" onerror="this.onerror=null;this.src='${placeholderImage}'" />
      </div>
      <div class="order-card-content">
        <div class="order-card-header">
          <div class="order-heading">
            <p class="order-id">#${escapeHtml(order.id || "--")}</p>
            <h3 class="order-title"><a href="${escapeHtml(etsyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(order.product || "Unnamed item")}</a></h3>
          </div>
          <div class="status-stack">
            <span class="status-chip ${status.type}">${escapeHtml(status.label)}</span>
            ${deliveredDate ? `<span class="delivered-date">${escapeHtml(deliveredDate)}</span>` : ""}
            ${order.admin?.status ? '<span class="admin-label">Override</span>' : ""}
            ${["cleared", "deleted"].includes(order.admin?.visibility) ? `<span class="admin-label">${escapeHtml(order.admin.visibility)}</span>` : ""}
          </div>
        </div>

        <div class="customer-row">
          <p class="order-customer">${escapeHtml(order.name || "Customer")}</p>
          <p class="order-location">${escapeHtml(location || order.country || "Location unavailable")}</p>
        </div>

        <div class="order-meta-row">
          <div>
            <span class="order-meta-label">${primaryDateLabel}</span>
            <strong>${primaryDateValue}</strong>
          </div>
          <div>
            <span class="order-meta-label">Total</span>
            <strong>${formatMoney(order.total)}</strong>
          </div>
          <div>
            <span class="order-meta-label">Items</span>
            <strong>${transactionCount || order.quantity || "--"}</strong>
          </div>
        </div>

        <div class="item-options">
          ${(order.transactions || []).map((item) => `
            <div class="item-option">
              ${transactionCount > 1 ? `<p class="item-name">${escapeHtml(item.title || "Item")} × ${escapeHtml(item.quantity || 1)}</p>` : ""}
              ${(item.variations || []).length ? item.variations.map((option) => `<p><span>${escapeHtml(option.name)}:</span> <strong>${escapeHtml(option.value)}</strong></p>`).join("") : '<p class="no-options">No options provided by Etsy</p>'}
            </div>
          `).join("")}
        </div>
        ${order.admin?.note ? `<div class="order-note"><span>Note</span><p>${escapeHtml(order.admin.note)}</p></div>` : ""}
        <div class="tracking-row">
          <span>Tracking</span>
          <strong>${escapeHtml(order.tracking || "Not available")}</strong>
          ${trackingDetails ? `<p class="tracking-details">${trackingDetails}</p>` : ""}
        </div>
      </div>
    </article>
  `;
}

function openOrder(url) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}


function render() {
  const grid = document.getElementById("grid");
  const emptyState = document.getElementById("empty");
  const visibleOrders = filteredOrders();
  updatePagination(visibleOrders.length);
  const pageOrders = visibleOrders.slice(page * pageSize, (page + 1) * pageSize);

  updateSummary(allOrders.filter((order) => !["cleared", "deleted"].includes(order.admin?.visibility)));
  updateMeta(allOrders.length, visibleOrders.length);
  updateTabs();

  grid.innerHTML = "";
  emptyState.style.display = "none";

  if (!pageOrders.length) {
    emptyState.textContent = activeFilter === "ALL"
      ? "No orders available. Try refreshing or connecting to Etsy."
      : `No ${activeFilter.toLowerCase()} orders found.`;
    emptyState.style.display = "grid";
    return;
  }

  grid.innerHTML = pageOrders.map(buildCard).join("");
}

async function load() {
  if (savingAdmin || document.getElementById("admin-dialog").open || document.getElementById("order-menu").matches(":popover-open")) return;
  const version = ++loadVersion;
  const grid = document.getElementById("grid");
  const emptyState = document.getElementById("empty");
  grid.innerHTML = "";
  emptyState.textContent = "Loading orders...";
  emptyState.style.display = "grid";

  try {
    const res = await fetch("/orders");
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.detail?.error_description || data?.detail?.error || data?.error || "Unable to load orders");
    }

    if (!Array.isArray(data)) {
      throw new Error("Unexpected orders response.");
    }

    if (version !== loadVersion) return;
    // Keep the unmodified source fields so resetting an override is immediate.
    sourceOrders = data.map((order) => ({
      ...order,
      ...(order.sourceOrder || {})
    }));
    allOrders = sourceOrders.map(applyOrderAdmin);
    lastUpdatedAt = new Date();
    page = 0;
    render();
  } catch (error) {
    if (version !== loadVersion) return;
    allOrders = [];
    updateSummary(allOrders.filter((order) => !["cleared", "deleted"].includes(order.admin?.visibility)));
    updateMeta(0, 0);
    updatePagination(0);
    grid.innerHTML = "";
    emptyState.textContent = error.message || "Unable to load orders. Please refresh.";
    emptyState.style.display = "grid";
    console.error(error);
  }
}

setInterval(() => {
  updateMeta(allOrders.length, filteredOrders().length);
}, 30000);

function refresh() {
  load();
}

function reconnectEtsy() {
  window.location.href = "/oauth";
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
    return;
  }

  document.exitFullscreen?.();
}

function setFilter(filter) {
  activeFilter = filter;
  page = 0;
  render();
}

function nextPage() {
  const total = filteredOrders().length;
  if ((page + 1) * pageSize < total) {
    page++;
    render();
  }
}

function prevPage() {
  if (page > 0) {
    page--;
    render();
  }
}

const orderMenu = document.getElementById("order-menu");
const adminDialog = document.getElementById("admin-dialog");
const adminForm = document.getElementById("admin-form");
let activeAdminAction = null;
let activeAdminId = null;

function closeOrderMenu() {
  orderMenu.hidePopover();
}

orderMenu.addEventListener("toggle", (event) => {
  if (event.newState === "closed") {
    document.querySelectorAll(".order-menu-trigger").forEach((button) => button.setAttribute("aria-expanded", "false"));
  }
});

document.getElementById("grid").addEventListener("click", (event) => {
  const trigger = event.target.closest(".order-menu-trigger");
  if (!trigger) {
    if (!event.target.closest("a, button, input, select, textarea")) {
      openOrder(event.target.closest(".order-card")?.dataset.orderUrl);
    }
    return;
  }
  if (savingAdmin) return;
  menuOrderId = trigger.dataset.orderId;
  const order = allOrders.find((entry) => String(entry.id) === menuOrderId);
  if (!order) return;
  const hidden = ["cleared", "deleted"].includes(order.admin?.visibility);
  orderMenu.innerHTML = `
    <button role="menuitem" data-action="status">Mark as…</button>
    <button role="menuitem" data-action="note">${order.admin?.note ? "Edit note" : "Add note"}</button>
    ${order.admin?.status ? '<button role="menuitem" data-action="reset-status">Use automatic status</button>' : ""}
    <button role="menuitem" data-action="${hidden ? "restore" : "clear"}">${hidden ? "Restore to dashboard" : "Clear from dashboard"}</button>
    ${order.admin?.visibility !== "deleted" ? '<button role="menuitem" class="danger-text" data-action="delete">Delete from dashboard</button>' : ""}
  `;
  orderMenu.showPopover();
  const rect = trigger.getBoundingClientRect();
  orderMenu.style.left = `${Math.max(8, Math.min(rect.right - orderMenu.offsetWidth, window.innerWidth - orderMenu.offsetWidth - 8))}px`;
  orderMenu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - orderMenu.offsetHeight - 8))}px`;
  trigger.setAttribute("aria-expanded", "true");
  orderMenu.querySelector("button").focus();
});

orderMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeOrderMenu();
    document.querySelector(`[data-order-id="${menuOrderId}"]`)?.focus();
    return;
  }
  const buttons = [...orderMenu.querySelectorAll("button")];
  const index = buttons.indexOf(document.activeElement);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
});

orderMenu.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const order = allOrders.find((entry) => String(entry.id) === menuOrderId);
  if (!order) return;
  activeAdminId = menuOrderId;
  activeAdminAction = button.dataset.action;
  closeOrderMenu();
  const titles = { status: "Mark order as", note: "Order note", clear: "Clear order", delete: "Delete from dashboard", restore: "Restore order", "reset-status": "Use automatic status" };
  const descriptions = {
    status: "Override the dashboard status until you select Use automatic status. Etsy and Shippo stay unchanged.",
    note: "Private dashboard note. Leave empty to remove it.",
    clear: "Move this order to Hidden. You can restore it there anytime.",
    delete: "Remove this order from the dashboard. It stays on Etsy and can be restored from Hidden.",
    restore: "Show this order on the dashboard again. Its note and status override are kept.",
    "reset-status": "Use the latest Etsy and Shippo status again. Your note is kept."
  };
  document.getElementById("admin-title").textContent = `${titles[activeAdminAction]} #${order.id}`;
  document.getElementById("admin-description").textContent = descriptions[activeAdminAction];
  document.getElementById("admin-status-field").hidden = activeAdminAction !== "status";
  document.getElementById("admin-note-field").hidden = activeAdminAction !== "note";
  document.getElementById("admin-status").innerHTML = Object.entries(statusLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  document.getElementById("admin-status").value = order.status;
  document.getElementById("admin-note").value = order.admin?.note || "";
  document.getElementById("admin-error").textContent = "";
  document.getElementById("admin-save").textContent = activeAdminAction === "delete" ? "Delete from dashboard" : "Save";
  adminDialog.showModal();
  document.getElementById(activeAdminAction === "note" ? "admin-note" : activeAdminAction === "status" ? "admin-status" : "admin-cancel").focus();
});

document.getElementById("admin-cancel").addEventListener("click", () => adminDialog.close());
adminDialog.addEventListener("cancel", (event) => { if (savingAdmin) event.preventDefault(); });
adminDialog.addEventListener("close", () => {
  document.querySelector(`[data-order-id="${activeAdminId}"]`)?.focus();
});

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingAdmin) return;
  savingAdmin = true;
  ++loadVersion; // Ignore any background refresh started before this edit.
  const payload = { action: activeAdminAction };
  if (activeAdminAction === "status") payload.status = document.getElementById("admin-status").value;
  if (activeAdminAction === "note") payload.note = document.getElementById("admin-note").value;
  document.getElementById("admin-error").textContent = "";
  adminForm.querySelectorAll("button, input, select, textarea").forEach((element) => element.disabled = true);
  try {
    const response = await fetch(`/orders/${encodeURIComponent(activeAdminId)}/admin`, {
      method: "PATCH", headers: { "Content-Type": "application/json", "X-Dashboard-Request": "1" }, body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to save changes");
    sourceOrders = sourceOrders.map((order) => String(order.id) === activeAdminId ? { ...order, admin: data.admin } : order);
    allOrders = sourceOrders.map(applyOrderAdmin);
    render();
    adminDialog.close();
    document.getElementById("admin-feedback").textContent = `Order #${activeAdminId} updated.`;
  } catch (error) {
    document.getElementById("admin-error").textContent = error.message || "Unable to save changes";
  } finally {
    savingAdmin = false;
    adminForm.querySelectorAll("button, input, select, textarea").forEach((element) => element.disabled = false);
  }
});

load();
setInterval(load, 600000);
