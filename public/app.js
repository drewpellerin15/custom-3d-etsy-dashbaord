let page = 0;
let activeFilter = "ALL";
let allOrders = [];
let lastUpdatedAt = null;

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
  if (activeFilter === "ALL") return allOrders;
  if (activeFilter === "SHIPPED") {
    return allOrders.filter((order) =>
      ["SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED", "TRACKING_ISSUE"].includes(order.status)
    );
  }
  if (activeFilter === "OPEN") {
    return allOrders.filter((order) => order.isOpen);
  }
  return allOrders.filter((order) => order.status === activeFilter);
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
    activeFilter === "ALL" ? `${total} orders` : `${visibleTotal} of ${total}`;
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
  const deliveredDate = order.status === "DELIVERED"
    ? formatDate(order.trackingStatusDate || order.shippedAt)
    : null;
  const hasShipped = ["SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED", "TRACKING_ISSUE"].includes(order.status);
  const primaryDateLabel = hasShipped ? "Shipped on" : "Ship by";
  const primaryDateValue = hasShipped
    ? formatDate(order.shippedAt || order.shipBy)
    : formatDate(order.shipBy);
  const etsyUrl = order.etsyUrl ||
    `https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav&order_id=${encodeURIComponent(order.receiptId || order.id || "")}`;

  return `
    <article class="order-card" role="link" tabindex="0" onclick="openOrder('${escapeHtml(etsyUrl)}')" onkeydown="handleOrderKey(event, '${escapeHtml(etsyUrl)}')">
      <div class="order-image">
        <img src="${escapeHtml(image)}" alt="" onerror="this.onerror=null;this.src='${placeholderImage}'" />
      </div>
      <div class="order-card-content">
        <div class="order-card-header">
          <div class="order-heading">
            <p class="order-id">#${escapeHtml(order.id || "--")}</p>
            <h3 class="order-title">${escapeHtml(order.product || "Unnamed item")}</h3>
          </div>
          <div class="status-stack">
            <span class="status-chip ${status.type}">${escapeHtml(status.label)}</span>
            ${deliveredDate ? `<span class="delivered-date">${escapeHtml(deliveredDate)}</span>` : ""}
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

        <div class="tracking-row">
          <span>Tracking</span>
          <strong>${escapeHtml(order.tracking || "Not available")}</strong>
        </div>
      </div>
    </article>
  `;
}

function openOrder(url) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function handleOrderKey(event, url) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openOrder(url);
  }
}

function render() {
  const grid = document.getElementById("grid");
  const emptyState = document.getElementById("empty");
  const visibleOrders = filteredOrders();
  const pageOrders = visibleOrders.slice(page * pageSize, (page + 1) * pageSize);

  updateSummary(allOrders);
  updateMeta(allOrders.length, visibleOrders.length);
  updatePagination(visibleOrders.length);
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

    allOrders = data;
    lastUpdatedAt = new Date();
    page = 0;
    render();
  } catch (error) {
    allOrders = [];
    updateSummary(allOrders);
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

load();
setInterval(load, 600000);
