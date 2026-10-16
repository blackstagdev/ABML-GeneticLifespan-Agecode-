// Builds Genetic LifeSpan channel API payloads from a Shopify order.
// Pure functions (no I/O) so they can be unit tested.
// Spec: docs/ALPHA-BIOMED-API-INTEGRATION.txt (sections 4-6).
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export const GLS_PRODUCT_TYPES = [
  "AgeCode Premier",
  "AgeCode Premier Follow-Up",
  "AgeCode Wellness Essentials Male",
  "AgeCode Wellness Essentials Female",
] as const;

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

export interface GlsPayload {
  alpha_order_id: string;
  product_type: string;
  quantity: number;
  price_paid: number;
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
}

export interface BuiltLine {
  lineItemId: string;
  alphaOrderId: string;
  productType: string;
  quantity: number;
  pricePaid: number;
  // null when the order is missing data the API requires
  payload: GlsPayload | null;
  errors: string[];
}

export interface BuildOptions {
  priceMode: "line_total" | "unit";
  appendAddress2: boolean;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const clean = (value: string | null | undefined) => (value ?? "").trim();

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

export function pricePaid(line: OrderLine, priceMode: BuildOptions["priceMode"]) {
  const lineTotal = roundMoney(line.originalUnitPrice * line.quantity - line.discountTotal);
  const total = Math.max(lineTotal, 0);
  return priceMode === "unit" ? roundMoney(total / Math.max(line.quantity, 1)) : total;
}

export function buildGlsLines(order: OrderInput, options: BuildOptions): BuiltLine[] {
  const agecodeLines = order.lines.filter((line) => isAgecodeLine(line) && line.quantity > 0);
  const ship = order.shippingAddress;

  const email = clean(order.email) || clean(order.customer?.email);
  const phone =
    [ship?.phone, order.billingAddress?.phone, order.phone, order.customer?.phone]
      .map((candidate) => normalizePhone(candidate, ship?.countryCodeV2))
      .find(Boolean) ?? null;
  const firstName =
    clean(ship?.firstName) || clean(order.billingAddress?.firstName) || clean(order.customer?.firstName);
  const lastName =
    clean(ship?.lastName) || clean(order.billingAddress?.lastName) || clean(order.customer?.lastName);

  let address1 = clean(ship?.address1);
  if (options.appendAddress2 && clean(ship?.address2)) address1 = `${address1}, ${clean(ship?.address2)}`;
  const shippingAddress = {
    address1,
    city: clean(ship?.city),
    province: clean(ship?.provinceCode),
    zip: clean(ship?.zip),
    country: clean(ship?.countryCodeV2),
  };

  const orderErrors: string[] = [];
  if (!ship) orderErrors.push("Order has no shipping address");
  if (!email) orderErrors.push("Missing email");
  if (!phone) orderErrors.push("Missing or invalid phone number");
  if (!firstName) orderErrors.push("Missing first name");
  if (!lastName) orderErrors.push("Missing last name");
  if (ship) {
    for (const [field, value] of Object.entries(shippingAddress)) {
      if (!value) orderErrors.push(`Missing shipping_address.${field}`);
    }
  }

  return agecodeLines.map((line, index) => {
    const productType = clean(line.productType);
    const alphaOrderId = index === 0 ? order.name : `${order.name}-${index + 1}`;
    const amount = pricePaid(line, options.priceMode);
    const errors = [...orderErrors];
    if (!(GLS_PRODUCT_TYPES as readonly string[]).includes(productType)) {
      errors.push(
        `Unknown gls.product_type "${productType}" on ${line.sku || line.title}. Expected one of: ${GLS_PRODUCT_TYPES.join(", ")}`,
      );
    }

    return {
      lineItemId: line.id,
      alphaOrderId,
      productType,
      quantity: line.quantity,
      pricePaid: amount,
      errors,
      payload: errors.length
        ? null
        : {
            alpha_order_id: alphaOrderId,
            product_type: productType,
            quantity: line.quantity,
            price_paid: amount,
            email,
            phone: phone!,
            first_name: firstName,
            last_name: lastName,
            shipping_address: shippingAddress,
          },
    };
  });
}
