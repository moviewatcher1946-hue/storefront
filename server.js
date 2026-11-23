/**
 * Data shapes used by server.js and public/index.html.
 * Documentation only: the project has no build step, nothing imports this file.
 */

/* ---------- catalog ---------- */

export interface Variation {
  id: string;                 // stable slug, e.g. "matte-black". Orders and carts reference this, never the name.
  name: string;               // "Matte Black"
  colorHex: string;           // "#1a1a1a" or "" (swatch falls back to the image, then the first letter)
  imageUrl?: string;          // high-res image. ONLY in GET /api/products/:id (and admin responses)
  hasImage: boolean;          // always present, so lists can show "has its own photo" without the image bytes
  priceModifier: number;      // signed pesos added to basePrice, 0 if none
  stockCount: number | null;  // null = not tracked per variation (only Product.stock applies)
}

export interface Product {
  id: number;
  title: string;              // same value as `name` (kept for older code)
  name: string;
  basePrice: number;          // same value as `price`
  price: number;
  was: number;                // original price, 0 if not on sale
  cat: string;
  stock: number;              // overall stock. A line can never exceed min(stock, variation.stockCount)
  description: string;        // plain text; a blank line starts a new paragraph. "" shows the fallback text
  desc: string;               // same as description (kept for older code)
  img: string;                // main image
  gallery?: string[];         // extra images, detail endpoint only (max 8)
  hasSizes: boolean;          // === availableSizes !== null
  availableSizes: string[] | null;
  sizes: string[];            // same list, never null
  variations: Variation[];    // [] when the product has no options
  vars: string[];             // legacy: variation names
  arch: boolean;
  favs: number;
  sold: number;
}

/* ---------- cart (browser only, localStorage "shop2") ---------- */

export interface CartLine {
  k: string;                  // `${id}|${vid}|${size}`, one line per combination
  id: number;
  vid: string;                // Variation.id ("" for products without variations)
  size: string;               // "" for products without sizes
  n: number;
}

/* ---------- checkout: POST /api/orders ---------- */

export interface CheckoutItem { id: number; vid: string; size: string; n: number }  // never send prices

export interface CheckoutRequest {
  items: CheckoutItem[];
  method: "delivery" | "pickup";
  pay: "GCash QR" | "Maya" | "Cash on Delivery" | "Pay at Pickup" | "Credit/Debit Card";
  name: string;
  phone: string;
  note?: string;
  addr: { rc: string; prov?: string; city: string; brgy: string; street: string; zip?: string; lat?: string; lng?: string } | null;
  pickup: string;
}

/* ---------- orders (snapshots: later edits to products or addresses never change an old order) ---------- */

export interface OrderItem {
  id: number;
  name: string;               // product name at purchase time
  v: string;                  // variation name at purchase time ("" if none)
  vid: string;                // variation id (used to restock on cancel)
  size: string;
  n: number;
  price: number;              // unit price actually charged: basePrice + priceModifier
}

export interface ShippingAddress {
  street: string;
  barangay: string;
  city: string;
  province: string;           // falls back to the region (e.g. NCR has no province)
  region: string;
  postalCode: string;
  country: string;            // "Philippines"
}

export type OrderStatus =
  | "Awaiting payment" | "Pending" | "Packed" | "Out for delivery" | "Delivered"
  | "Ready for pickup" | "Picked up" | "Cancelled";

export interface Order {
  id: number;
  created: string;            // ISO date
  method: "delivery" | "pickup";
  items: OrderItem[];
  shippingAddress: ShippingAddress | null;   // null for pickup orders
  pickup: string;             // pickup slot, "" for delivery
  paymentMethod: string;      // "GCash QR", "Cash on Delivery", ...
  orderStatus: OrderStatus;
  subtotal: number;
  fee: number;
  total: number;
  name: string;
  phone: string;
  note: string;
  /* legacy aliases, same values */
  status: OrderStatus; pay: string; addr: Record<string, string> | null;
}

/* ---------- API ---------- */
// GET   /api/bootstrap           -> { prods: Product[] (no variation images / gallery), ... }
// GET   /api/products/:id        -> Product (full: variation images + gallery)
// PATCH /api/admin/products/:id  -> accepts { desc, sizes: string[], variations: Variation[], gallery: string[], ... }
// POST  /api/orders              -> Order
// GET   /api/orders              -> Order[]
