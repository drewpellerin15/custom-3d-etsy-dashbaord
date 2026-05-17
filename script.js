let page = 0;
const pageSize = 12;

async function fetchOrders() {
  const res = await fetch(`/orders?page=${page}&pageSize=${pageSize}`);
  return await res.json();
}

function refreshOrders() {
  render();
}

function nextPage() {
  page++;
  render();
}

function prevPage() {
  if (page > 0) page--;
  render();
}

async function setOverride(id, status) {
  await fetch("/override", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id, status })
  });

  render();
}