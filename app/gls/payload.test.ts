import { describe, expect, it } from "vitest";
import { buildGlsOrder, describeItems, normalizePhone, unitPrice, type OrderInput, type OrderLine } from "./payload";

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "gid://shopify/LineItem/1",
    title: "AgeCode™ Premier",
    sku: "AGC-PREMIER",
    quantity: 1,
    productType: "AgeCode Premier",
    originalUnitPrice: 1200,
    discountTotal: 0,
    ...overrides,
  };
}

function order(overrides: Partial<OrderInput> = {}): OrderInput {
  return {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    email: "provider@example.com",
    phone: null,
    tags: [],
    shippingAddress: {
      firstName: "Jane",
      lastName: "Doe",
      address1: "123 Main St",
      address2: "Apt 4",
      city: "Austin",
      provinceCode: "TX",
      zip: "78701",
      countryCodeV2: "US",
      phone: "(512) 555-0142",
    },
    billingAddress: null,
    customer: null,
    lines: [line()],
    ...overrides,
  };
}

const contact = {
  alpha_order_id: "#1001",
  email: "provider@example.com",
  phone: "+15125550142",
  first_name: "Jane",
  last_name: "Doe",
  shipping_address: { address1: "123 Main St, Apt 4", city: "Austin", province: "TX", zip: "78701", country: "US" },
};

describe("buildGlsOrder", () => {
  it("sends one product in the single-product format with unit_price", () => {
    const built = buildGlsOrder(order({ lines: [line({ quantity: 3 })] }))!;
    expect(built.errors).toEqual([]);
    expect(built.payload).toEqual({
      ...contact,
      product_type: "AgeCode Premier",
      quantity: 3,
      unit_price: 1200,
      price_paid: 3600,
    });
  });

  it("sends a mixed cart as one order with items[] and skips non-AgeCode lines", () => {
    const built = buildGlsOrder(
      order({
        lines: [
          line({ id: "a" }),
          line({ id: "b", productType: null, sku: "BPC-157", title: "Peptide", originalUnitPrice: 80 }),
          line({ id: "c", productType: "AgeCode Wellness Essentials", sku: "AGC-WE", quantity: 2, originalUnitPrice: 400 }),
        ],
      }),
    )!;
    expect(built.payload).toEqual({
      ...contact,
      price_paid: 2000,
      items: [
        { product_type: "AgeCode Premier", quantity: 1, unit_price: 1200 },
        { product_type: "AgeCode Wellness Essentials", quantity: 2, unit_price: 400 },
      ],
    });
    expect(built.items.map((item) => item.lineItemId)).toEqual(["a", "c"]);
    expect(describeItems(built.items)).toBe("AgeCode Premier ×1, AgeCode Wellness Essentials ×2");
  });

  it("converts the old Male/Female values to the unisex Wellness Essentials", () => {
    const built = buildGlsOrder(
      order({ lines: [line({ productType: "AgeCode Wellness Essentials Female", originalUnitPrice: 400 })] }),
    )!;
    expect(built.payload?.product_type).toBe("AgeCode Wellness Essentials");
  });

  it("returns null for orders without AgeCode items", () => {
    expect(buildGlsOrder(order({ lines: [line({ productType: null })] }))).toBeNull();
  });

  it("rejects an unknown product type", () => {
    const built = buildGlsOrder(order({ lines: [line({ productType: "AgeCode Premium" })] }))!;
    expect(built.payload).toBeNull();
    expect(built.errors[0]).toContain('Unknown gls.product_type "AgeCode Premium"');
  });

  it("sends test orders with a TEST- id and first name TEST when tagged gls-test", () => {
    const built = buildGlsOrder(order({ tags: ["gls-test"] }))!;
    expect(built.isTest).toBe(true);
    expect(built.payload).toMatchObject({ alpha_order_id: "TEST-1001", first_name: "TEST", last_name: "Doe" });
  });

  it("can force the test format for every order", () => {
    expect(buildGlsOrder(order(), { forceTest: true })!.alphaOrderId).toBe("TEST-1001");
  });

  it("falls back to billing, order and customer phone", () => {
    const base = order();
    const built = buildGlsOrder({
      ...base,
      shippingAddress: { ...base.shippingAddress!, phone: null },
      customer: { firstName: null, lastName: null, email: null, phone: "+1 512 555 0199" },
    })!;
    expect(built.payload?.phone).toBe("+15125550199");
  });

  it("reports every missing required field", () => {
    const base = order();
    const built = buildGlsOrder({
      ...base,
      email: null,
      shippingAddress: { ...base.shippingAddress!, phone: null, provinceCode: null, zip: "" },
    })!;
    expect(built.payload).toBeNull();
    expect(built.errors).toEqual(
      expect.arrayContaining([
        "Missing email",
        "Missing or invalid phone number",
        "Missing shipping_address.province",
        "Missing shipping_address.zip",
      ]),
    );
  });

  it("fails orders with no shipping address", () => {
    expect(buildGlsOrder(order({ shippingAddress: null }))!.errors).toContain("Order has no shipping address");
  });

  it("never sends an address2 field", () => {
    const built = buildGlsOrder(order())!;
    expect(built.payload?.shipping_address).not.toHaveProperty("address2");
  });
});

describe("unitPrice", () => {
  it("is the per-unit price after all discounts allocated to the line", () => {
    expect(unitPrice(line({ quantity: 3, originalUnitPrice: 1200, discountTotal: 360 }))).toBe(1080);
  });

  it("rounds to cents", () => {
    expect(unitPrice(line({ quantity: 3, originalUnitPrice: 399, discountTotal: 100 }))).toBe(365.67);
  });

  it("never goes below zero", () => {
    expect(unitPrice(line({ discountTotal: 5000 }))).toBe(0);
  });
});

describe("normalizePhone", () => {
  it("formats US numbers as E.164", () => {
    expect(normalizePhone("512-555-0142", "US")).toBe("+15125550142");
  });

  it("keeps digits for numbers it cannot validate", () => {
    expect(normalizePhone("000 000 0000", "US")).toBe("0000000000");
  });

  it("rejects empty or too-short values", () => {
    expect(normalizePhone("", "US")).toBeNull();
    expect(normalizePhone("12345", "US")).toBeNull();
  });
});
