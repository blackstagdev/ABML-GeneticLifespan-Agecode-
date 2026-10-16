import { describe, expect, it } from "vitest";
import { buildGlsLines, normalizePhone, pricePaid, type OrderInput, type OrderLine } from "./payload";

const options = { priceMode: "line_total" as const, appendAddress2: true };

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "gid://shopify/LineItem/1",
    title: "AgeCode™ Premier",
    sku: "AGC-PREMIER",
    quantity: 1,
    productType: "AgeCode Premier",
    originalUnitPrice: 399,
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
    shippingAddress: {
      firstName: "Jane",
      lastName: "Doe",
      address1: "123 Main St",
      address2: "Suite 4",
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

describe("buildGlsLines", () => {
  it("maps a Premier order to the documented payload", () => {
    const [built] = buildGlsLines(order(), options);
    expect(built.errors).toEqual([]);
    expect(built.payload).toEqual({
      alpha_order_id: "#1001",
      product_type: "AgeCode Premier",
      quantity: 1,
      price_paid: 399,
      email: "provider@example.com",
      phone: "+15125550142",
      first_name: "Jane",
      last_name: "Doe",
      shipping_address: {
        address1: "123 Main St, Suite 4",
        city: "Austin",
        province: "TX",
        zip: "78701",
        country: "US",
      },
    });
  });

  it("ignores non-AgeCode lines and numbers multiple AgeCode lines", () => {
    const built = buildGlsLines(
      order({
        lines: [
          line({ id: "a" }),
          line({ id: "b", productType: null, sku: "BPC-157", title: "Peptide" }),
          line({ id: "c", productType: "AgeCode Wellness Essentials Female", sku: "AGC-WE-F" }),
        ],
      }),
      options,
    );
    expect(built.map((item) => [item.lineItemId, item.alphaOrderId, item.productType])).toEqual([
      ["a", "#1001", "AgeCode Premier"],
      ["c", "#1001-2", "AgeCode Wellness Essentials Female"],
    ]);
  });

  it("returns nothing for orders without AgeCode items", () => {
    expect(buildGlsLines(order({ lines: [line({ productType: null })] }), options)).toEqual([]);
  });

  it("rejects an unknown product type such as plain Wellness Essentials", () => {
    const [built] = buildGlsLines(order({ lines: [line({ productType: "AgeCode Wellness Essentials" })] }), options);
    expect(built.payload).toBeNull();
    expect(built.errors[0]).toContain('Unknown gls.product_type "AgeCode Wellness Essentials"');
  });

  it("falls back to billing, order and customer phone", () => {
    const base = order();
    const [built] = buildGlsLines(
      {
        ...base,
        shippingAddress: { ...base.shippingAddress!, phone: null },
        customer: { firstName: null, lastName: null, email: null, phone: "+1 512 555 0199" },
      },
      options,
    );
    expect(built.payload?.phone).toBe("+15125550199");
  });

  it("reports every missing required field", () => {
    const base = order();
    const [built] = buildGlsLines(
      {
        ...base,
        email: null,
        shippingAddress: { ...base.shippingAddress!, phone: null, provinceCode: null, zip: "" },
      },
      options,
    );
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
    const [built] = buildGlsLines(order({ shippingAddress: null }), options);
    expect(built.errors).toContain("Order has no shipping address");
  });

  it("can leave address2 out", () => {
    const [built] = buildGlsLines(order(), { ...options, appendAddress2: false });
    expect(built.payload?.shipping_address.address1).toBe("123 Main St");
  });
});

describe("pricePaid", () => {
  it("uses the line total after discounts", () => {
    expect(pricePaid(line({ quantity: 3, originalUnitPrice: 399, discountTotal: 119.7 }), "line_total")).toBe(1077.3);
  });

  it("can send the per-unit amount", () => {
    expect(pricePaid(line({ quantity: 3, originalUnitPrice: 399, discountTotal: 119.7 }), "unit")).toBe(359.1);
  });

  it("never goes below zero", () => {
    expect(pricePaid(line({ discountTotal: 500 }), "line_total")).toBe(0);
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
