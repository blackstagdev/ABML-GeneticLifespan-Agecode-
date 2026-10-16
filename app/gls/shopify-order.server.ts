// Shopify Admin GraphQL calls used by the processor.
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { OrderInput } from "./payload";

export const SYNC_METAFIELD = { namespace: "gls", key: "sync" } as const;

const ORDER_QUERY = `#graphql
  query AgecodeOrder($id: ID!) {
    order(id: $id) {
      id
      name
      email
      phone
      cancelledAt
      tags
      shippingAddress {
        firstName
        lastName
        address1
        address2
        city
        provinceCode
        zip
        countryCodeV2
        phone
      }
      billingAddress {
        firstName
        lastName
        phone
      }
      customer {
        firstName
        lastName
        defaultEmailAddress {
          emailAddress
        }
        defaultPhoneNumber {
          phoneNumber
        }
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          sku
          currentQuantity
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
          discountAllocations {
            allocatedAmountSet {
              shopMoney {
                amount
              }
            }
          }
          variant {
            id
            productType: metafield(namespace: "gls", key: "product_type") {
              value
            }
          }
        }
      }
    }
  }`;

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query AgecodeFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
              lineItem {
                id
              }
            }
          }
        }
      }
    }
  }`;

const FULFILLMENT_CREATE = `#graphql
  mutation AgecodeFulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
    fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
      fulfillment {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const TAGS_ADD = `#graphql
  mutation AgecodeTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }`;

const METAFIELDS_SET = `#graphql
  mutation AgecodeMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }`;

const ORDER_BY_NAME_QUERY = `#graphql
  query AgecodeOrderByName($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
      }
    }
  }`;

type Admin = AdminApiContext;

async function gql<T>(admin: Admin, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const json = (await response.json()) as { data?: T; errors?: unknown };
  if (json.errors || !json.data) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

function assertNoUserErrors(label: string, userErrors: { message: string }[] | undefined) {
  if (userErrors?.length) {
    throw new Error(`${label}: ${userErrors.map((error) => error.message).join("; ")}`);
  }
}

const amount = (value: { amount: string } | null | undefined) => Number(value?.amount ?? 0);

type Money = { shopMoney: { amount: string } } | null;

interface OrderQueryResult {
  order: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    cancelledAt: string | null;
    tags: string[];
    shippingAddress: OrderInput["shippingAddress"];
    billingAddress: OrderInput["billingAddress"];
    customer: {
      firstName: string | null;
      lastName: string | null;
      defaultEmailAddress: { emailAddress: string | null } | null;
      defaultPhoneNumber: { phoneNumber: string } | null;
    } | null;
    lineItems: {
      nodes: {
        id: string;
        title: string;
        sku: string | null;
        currentQuantity: number;
        originalUnitPriceSet: Money;
        discountAllocations: { allocatedAmountSet: Money }[];
        variant: { id: string; productType: { value: string } | null } | null;
      }[];
    };
  } | null;
}

interface FulfillmentOrdersQueryResult {
  order: {
    fulfillmentOrders: {
      nodes: {
        id: string;
        status: string;
        lineItems: { nodes: { id: string; remainingQuantity: number; lineItem: { id: string } }[] };
      }[];
    };
  } | null;
}

export interface LoadedOrder extends OrderInput {
  cancelled: boolean;
  tags: string[];
}

export async function loadOrder(admin: Admin, orderGid: string): Promise<LoadedOrder | null> {
  const data = await gql<OrderQueryResult>(admin, ORDER_QUERY, { id: orderGid });
  const order = data.order;
  if (!order) return null;

  return {
    id: order.id,
    name: order.name,
    email: order.email,
    phone: order.phone,
    cancelled: Boolean(order.cancelledAt),
    tags: order.tags ?? [],
    shippingAddress: order.shippingAddress,
    billingAddress: order.billingAddress,
    customer: order.customer
      ? {
          firstName: order.customer.firstName,
          lastName: order.customer.lastName,
          email: order.customer.defaultEmailAddress?.emailAddress ?? null,
          phone: order.customer.defaultPhoneNumber?.phoneNumber ?? null,
        }
      : null,
    lines: order.lineItems.nodes.map((line) => ({
      id: line.id,
      title: line.title,
      sku: line.sku,
      quantity: line.currentQuantity,
      productType: line.variant?.productType?.value ?? null,
      originalUnitPrice: amount(line.originalUnitPriceSet?.shopMoney),
      discountTotal: (line.discountAllocations ?? []).reduce(
        (sum, allocation) => sum + amount(allocation.allocatedAmountSet?.shopMoney),
        0,
      ),
    })),
  };
}

export async function findOrderGidByName(admin: Admin, name: string) {
  const normalized = name.trim().startsWith("#") ? name.trim() : `#${name.trim()}`;
  const data = await gql<{ orders: { nodes: { id: string; name: string }[] } }>(admin, ORDER_BY_NAME_QUERY, {
    query: `name:${normalized}`,
  });
  return data.orders.nodes[0] ?? null;
}

// Marks the given line items fulfilled (without notifying the customer) so ShipStation
// never treats them as awaiting shipment. Returns how many fulfillment orders were touched.
export async function fulfillOrderLines(admin: Admin, orderGid: string, lineItemGids: string[], message: string) {
  const data = await gql<FulfillmentOrdersQueryResult>(admin, FULFILLMENT_ORDERS_QUERY, { id: orderGid });
  const wanted = new Set(lineItemGids);
  const groups: { fulfillmentOrderId: string; fulfillmentOrderLineItems: { id: string; quantity: number }[] }[] = [];

  for (const fulfillmentOrder of data.order?.fulfillmentOrders?.nodes ?? []) {
    if (!["OPEN", "IN_PROGRESS"].includes(fulfillmentOrder.status)) continue;
    const items = fulfillmentOrder.lineItems.nodes
      .filter((item) => wanted.has(item.lineItem.id) && item.remainingQuantity > 0)
      .map((item) => ({ id: item.id, quantity: item.remainingQuantity }));
    if (items.length) groups.push({ fulfillmentOrderId: fulfillmentOrder.id, fulfillmentOrderLineItems: items });
  }

  for (const group of groups) {
    const result = await gql<{ fulfillmentCreate: { userErrors: { message: string }[] } }>(admin, FULFILLMENT_CREATE, {
      fulfillment: { lineItemsByFulfillmentOrder: [group], notifyCustomer: false },
      message,
    });
    assertNoUserErrors("fulfillmentCreate", result.fulfillmentCreate.userErrors);
  }
  return groups.length;
}

export async function addOrderTags(admin: Admin, orderGid: string, tags: string[]) {
  const result = await gql<{ tagsAdd: { userErrors: { message: string }[] } }>(admin, TAGS_ADD, {
    id: orderGid,
    tags,
  });
  assertNoUserErrors("tagsAdd", result.tagsAdd.userErrors);
}

export async function setSyncMetafield(admin: Admin, orderGid: string, value: unknown) {
  const result = await gql<{ metafieldsSet: { userErrors: { message: string }[] } }>(admin, METAFIELDS_SET, {
    metafields: [
      {
        ownerId: orderGid,
        namespace: SYNC_METAFIELD.namespace,
        key: SYNC_METAFIELD.key,
        type: "json",
        value: JSON.stringify(value),
      },
    ],
  });
  assertNoUserErrors("metafieldsSet", result.metafieldsSet.userErrors);
}
