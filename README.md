# Etsy dashboard

Run `npm ci`, configure the existing Etsy/Shippo credentials, and start with `npm start`.
Run the backend regression checks with `npm test` (no live Etsy orders or credentials required).

## Order options and admin controls

Each item displays the variation names and values supplied by Etsy, including the selected
3-key switch or remote controlled light. Multi-item orders show options under each item's
title. Older items without variation data show “No options provided by Etsy”; the dashboard
does not assume a light type.

Use the three-dot button on an order to:

- Mark it open, in progress, ready to ship, shipped, in transit, delivered, returned,
  tracking issue, or canceled. Overrides remain until **Use automatic status** is selected.
- Add, edit, or remove a private dashboard note (up to 2,000 characters).
- Clear it from the active dashboard or delete it from the dashboard. Both operations are
  reversible from **Hidden**, and neither cancels or deletes the Etsy order.
- Restore a hidden order, keeping its note and status override.

These actions use the existing dashboard password/session and only change dashboard data.
They never update Etsy orders or Shippo tracking. The dashboard still loads the latest 100
Etsy receipts, so the Hidden view, like the other views, covers that fetched order window.

## Persistent admin data

Admin settings are stored separately from the tracking cache in `order-admin.json` and
written atomically. Keep this file on persistent storage and include it in backups.
For hosts with ephemeral application disks, set `ORDER_ADMIN_PATH` to a writable file on a
persistent volume (for example `/data/order-admin.json`). The containing directory is created
when saving. Do not commit this file: it can contain private order notes.

`ORDER_CACHE_PATH` can similarly point the existing tracking cache at persistent storage.
Without a persistent volume, replacing an ephemeral deployment can discard locally stored data.
