// Builds the Genetic LifeSpan channel API payload for a Shopify order.
// Pure functions (no I/O) so they can be unit tested.
// Spec: docs/ALPHA-BIOMED-API-INTEGRATION V2 (10/23/2026), sections 4-6.
//   - one request per Shopify order (top-level product fields for one AgeCode line, items[] for several)
//   - unit_price = per unit after discounts, no tax or shipping; price_paid = product total
//   - no address2 field: apt/suite goes on address1
//   - test orders: alpha_order_id "TEST-..." and first_name "TEST"
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export const GLS_PRODUCT_TYPES = [
  "AgeCode Premier",
  "AgeCode Premier Follow-Up",
  "AgeCode Wellness Essentials",
] as const;

// Values from the V1 spec that we still accept on variants and convert (Wellness Essentials is unisex in V2).
const LEGACY_PRODUCT_TYPES: Record<string, string> = {
  "AgeCode Wellness Essentials Male": "AgeCode Wellness Essentials",
  "AgeCode Wellness Essentials Female": "AgeCode Wellness Essentials",
};

export interface OrderAddress {
  firstName: string | null;
  lastName: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  provinceCode: string | null;
  zip: string | null;
  countryCodeV2: string | null;
  phone: string | null;
}

export interface OrderLine {
  id: string;
  title: string;
  sku: string | null;
  quantity: number;
  // value of the variant metafield gls.product_type
  productType: string | null;
  // amounts in shop currency
  originalUnitPrice: number;
  discountTotal: number;
}

export interface OrderInput {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tags?: string[];
  shippingAddress: OrderAddress | null;
  billingAddress: Pick<OrderAddress, "phone" | "firstName" | "lastName"> | null;
  customer: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  lines: OrderLine[];
}

export interface GlsItem {
  product_type: string;
  quantity: number;
  unit_price: number;
}

export interface GlsPayload {
  alpha_order_id: string;
  email: string;
  phone: string;
  first_name: string;
  last_name: string;
  shipping_address: {
    address1: string;
    city: string;
    province: string;
    zip: string;
    country: string;
  };
  price_paid: number;
  // single-product order (V2 section 5.2)
  product_type?: string;
  quantity?: number;
  unit_price?: number;
  // mixed order (V2 section 5.3)
  items?: GlsItem[];
}

export interface BuiltItem {
  lineItemId: string;
  productType: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface BuiltOrder {
  alphaOrderId: string;
  isTest: boolean;
  items: BuiltItem[];
  pricePaid: number;
  // null when the order is missing data the API requires
  payload: GlsPayload | null;
  errors: string[];
}

export interface BuildOptions {
  // send in the V2 test format (TEST- prefix, first name TEST)
  forceTest?: boolean;
}

export const TEST_ORDER_TAG = "gls-test";

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const clean = (value: string | null | undefined) => (value ?? "").trim();

export function normalizeProductType(value: string | null | undefined) {
  const type = clean(value);
  return LEGACY_PRODUCT_TYPES[type] ?? type;
}

export function isAgecodeLine(line: OrderLine) {
  return clean(line.productType) !== "";
}

export function normalizePhone(raw: string | null | undefined, country?: string | null) {
  const value = clean(raw);
  if (!value) return null;
  const parsed = parsePhoneNumberFromString(value, (country || "US") as CountryCode);
  if (parsed?.isValid()) return parsed.number; // E.164, e.g. +15551234567
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

// Per-unit price after all discounts allocated to the line. Tax and shipping are not included.
export function unitPrice(line: OrderLine) {
  const lineTotal = Math.max(line.originalUnitPrice * line.quantity - line.discountTotal, 0);
  return roundMoney(lineTotal / Math.max(line.quantity, 1));
}

export function buildGlsOrder(order: OrderInput, options: BuildOptions = {}): BuiltOrder | null {
  const agecodeLines = order.lines.filter((line) => isAgecodeLine(line) && line.quantity > 0);
  if (!agecodeLines.length) return null;

  const isTest = Boolean(options.forceTest) || (order.tags ?? []).includes(TEST_ORDER_TAG);
  const orderNumber = order.name.replace(/^#/, "");
  const alphaOrderId = isTest ? `TEST-${orderNumber}` : order.name;
  const ship = order.shippingAddress;
  const errors: string[] = [];

  const items: BuiltItem[] = agecodeLines.map((line) => {
    const productType = normalizeProductType(line.productType);
    if (!(GLS_PRODUCT_TYPES as readonly string[]).includes(productType)) {
      errors.push(
        `Unknown gls.product_type "${clean(line.productType)}" on ${line.sku || line.title}. Expected one of: ${GLS_PRODUCT_TYPES.join(", ")}`,
      );
    }
    const price = unitPrice(line);
    return {
      lineItemId: line.id,
      productType,
      quantity: line.quantity,
      unitPrice: price,
      lineTotal: roundMoney(price * line.quantity),
    };
  });
  const pricePaid = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));

  const email = clean(order.email) || clean(order.customer?.email);
  const phone =
    [ship?.phone, order.billingAddress?.phone, order.phone, order.customer?.phone]
      .map((candidate) => normalizePhone(candidate, ship?.countryCodeV2))
      .find(Boolean) ?? null;
  const firstName =
    clean(ship?.firstName) || clean(order.billingAddress?.firstName) || clean(order.customer?.firstName);
  const lastName =
    clean(ship?.lastName) || clean(order.billingAddress?.lastName) || clean(order.customer?.lastName);

  // The API has no address2: apt/suite/unit goes on address1.
  const address1 = [clean(ship?.address1), clean(ship?.address2)].filter(Boolean).join(", ");
  const shippingAddress = {
    address1,
    city: clean(ship?.city),
    province: clean(ship?.provinceCode),
    zip: clean(ship?.zip),
    country: clean(ship?.countryCodeV2),
  };

  if (!ship) errors.push("Order has no shipping address");
  if (!email) errors.push("Missing email");
  if (!phone) errors.push("Missing or invalid phone number");
  if (!firstName) errors.push("Missing first name");
  if (!lastName) errors.push("Missing last name");
  if (ship) {
    for (const [field, value] of Object.entries(shippingAddress)) {
      if (!value) errors.push(`Missing shipping_address.${field}`);
    }
  }

  const base = {
    alpha_order_id: alphaOrderId,
    email,
    phone: phone ?? "",
    first_name: isTest ? "TEST" : firstName,
    last_name: lastName,
    shipping_address: shippingAddress,
    price_paid: pricePaid,
  };

  const payload: GlsPayload =
    items.length === 1
      ? { ...base, product_type: items[0].productType, quantity: items[0].quantity, unit_price: items[0].unitPrice }
      : {
          ...base,
          items: items.map((item) => ({
            product_type: item.productType,
            quantity: item.quantity,
            unit_price: item.unitPrice,
          })),
        };

  return { alphaOrderId, isTest, items, pricePaid, errors, payload: errors.length ? null : payload };
}

export function describeItems(items: Pick<BuiltItem, "productType" | "quantity">[]) {
  return items.map((item) => `${item.productType} ×${item.quantity}`).join(", ");
}
