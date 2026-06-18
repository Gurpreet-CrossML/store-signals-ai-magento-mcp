const axios = require("axios");
const dotenv = require("dotenv");
const https = require("https");
const { getCache, setCache } = require("./cache");

// Load environment variables from .env file
dotenv.config();

const MAGENTO_BASE_URL = process.env.MAGENTO_BASE_URL;
const MAGENTO_API_TOKEN = process.env.MAGENTO_API_TOKEN;
const SORT_CODE = process.env.SORT_CODE;
const SORT_DIR = process.env.SORT_DIR;
const WEBSITE_ID = parseInt(process.env.WEBSITE_ID || 4);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const BACKEND_API_URL = process.env.BACKEND_API_URL;
const PORT = process.env.PORT;
const ZENDESK_API_URL = process.env.ZENDESK_API_URL;
const ZENDESK_USERNAME = process.env.ZENDESK_USERNAME;
const ZENDESK_PASSWORD = process.env.ZENDESK_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const MCP_NAME = process.env.MCP_NAME;
const MCP_VERSION = process.env.MCP_VERSION;

const allEnvironmentVariables = {
  MAGENTO_BASE_URL,
  MAGENTO_API_TOKEN,
  SORT_CODE,
  SORT_DIR,
  WEBSITE_ID,
  SMTP_USER,
  SMTP_PASS,
  BACKEND_API_URL,
  PORT,
  ZENDESK_API_URL,
  ZENDESK_USERNAME,
  ZENDESK_PASSWORD,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  MCP_NAME,
  MCP_VERSION,
};

// Validate environment variables
for (const [key, value] of Object.entries(allEnvironmentVariables)) {
  if (!value) {
    console.error(`ERROR: ${key} environment variable is required`);
    process.exit(1);
  }
}

// Define sort options and their mapping to sort keys and reverse flags
const SortOption = Object.freeze({
  RELEVANCE: "relevance",
  PRICE_ASC: "price_asc",
  PRICE_DESC: "price_desc",
  BEST_RATING: "best_rating",
  BEST_SELLING: "bestsellers",
});

// Mapping of user-friendly sort options to sort keys and reverse flags
const SORT_MAPPING = {
  [SortOption.RELEVANCE]: {
    sortCode: "relevance",
    sortDir: "ASC",
  },

  [SortOption.PRICE_ASC]: {
    sortCode: "price",
    sortDir: "ASC",
  },

  [SortOption.PRICE_DESC]: {
    sortCode: "price",
    sortDir: "DESC",
  },

  [SortOption.BEST_RATING]: {
    sortCode: "bast-rating",
    sortDir: "DESC",
  },

  [SortOption.BEST_SELLING]: {
    sortCode: "bestsellers",
    sortDir: "DESC",
  },
};

// Utility function to call Magento API
const callMagentoApi = async (
  method = "GET",
  endpoint = "",
  data = null,
  store_code = "",
  isGraphQL = false,
) => {
  try {
    let url = isGraphQL
      ? `${MAGENTO_BASE_URL}/graphql`
      : `${MAGENTO_BASE_URL}/rest/V1${endpoint}`;

    console.log(`Calling Magento API: ${method} - ${url}`);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MAGENTO_API_TOKEN}`,
    };

    if (store_code) {
      headers["Store"] = store_code;
    }

    const config = {
      method,
      url,
      headers,
      timeout: 15000, // 15 seconds timeout
      data: data ? JSON.stringify(data) : undefined,

      // Bypass SSL certificate verification for development
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
    };

    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(
      "Magento API Error:",
      error?.response?.data || error.message || error?.errors || error,
    );
    throw error;
  }
};

// Utility function to call the backend API
const callBackendAPI = async (method, endpoint, data = {}) => {
  try {
    const url = `${BACKEND_API_URL}${endpoint}`;

    console.log(`Calling Backend API: ${method} - ${url}`);

    const config = {
      method,
      url,
      timeout: 15000,
      data: data,
    };

    const response = await axios(config);
    return response?.data?.data;
  } catch (err) {
    console.error("Error calling backend API, error:", err?.response?.data);
    return null;
  }
};

// Utility function to get currency symbol from currency code
const getCurrencySymbol = (code) => {
  const symbols = {
    USD: "$",
    INR: "₹",
    EUR: "€",
  };
  return symbols[code] || (code ? `${code} ` : "");
};

// Save viewed products to backend for analytics
const logProductViewEvents = async (products, session_id, store_code) => {
  if (!Array.isArray(products) || !session_id || !store_code) {
    return;
  }

  await Promise.all(
    products.map((product) => {
      const productId = String(product?.id || "")
        .split("/")
        .pop();
      if (!productId) return Promise.resolve();

      return callBackendAPI("POST", "/chat/bot-events/", {
        thread_id: session_id,
        event_type: "view_product",
        store_code,
        product_id: productId,
        product_name: product?.name || "",
        category: product?.category || "",
      });
    }),
  ).catch((err) => {
    console.warn("logProductViewEvents failed:", err?.message || err);
  });
};

// Utility function to extract text from the html
const htmlToText = (html) => {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// Utility function to format products data received from Magento API
const formatProducts = (products, full_details = false) => {
  try {
    if (!products || products?.length === 0) return [];

    return products.map((product) => {
      const productId = product.id;
      const productName = product.name;
      const productCategory =
        product?.categories && product?.categories?.length > 0
          ? product?.categories[0].name
          : "";

      const baseProduct = {
        id: productId,
        name: productName,
        category: productCategory,
        price: `${getCurrencySymbol(product.price?.regularPrice?.amount?.currency)}${product.special_price || product.price?.regularPrice?.amount?.value}`,
        description: htmlToText(product.description?.html) || "",
        available_for_sale: product.stock_status === "IN_STOCK",
      };

      if (!full_details) {
        return baseProduct;
      }

      // Store avaialable options for a product, if that product has variants
      const optionMap = {};
      product.configurable_options?.forEach((option) => {
        optionMap[option.attribute_code] = {};

        option.values.forEach((value) => {
          optionMap[option.attribute_code][value.value_index] = value.label;
        });
      });

      return {
        ...baseProduct,
        image:
          product?.media_gallery_entries &&
          product?.media_gallery_entries?.length > 0
            ? `${MAGENTO_BASE_URL}/media/catalog/product/${product?.media_gallery_entries[0].file}`
            : `${MAGENTO_BASE_URL}/media/catalog/product/placeholder/websites/4/mb-logo.webp`,
        product_url: `${MAGENTO_BASE_URL}/${product.url_path || product.url_key}${product.url_suffix}`,
        variants: product.variants?.map((variant) => {
          const { product: p, attributes } = variant;
          const options = [];

          attributes?.forEach((attr) => {
            const optionName =
              product.configurable_options?.find(
                (opt) => opt.attribute_code === attr.code,
              )?.label || attr.code;

            options.push({
              name: optionName,
              value:
                optionMap[attr.code]?.[attr.value_index] ?? attr.value_index,
            });
          });

          return {
            variant_id: p.id,
            variant_sku: p.sku,
            variant_name: p.name,
            variant_price: `${getCurrencySymbol(
              p.price?.regularPrice?.amount?.currency,
            )}${p.price?.regularPrice?.amount?.value ?? 0}`,
            available_for_sale: p.stock_status === "IN_STOCK",
            options,
          };
        }),
      };
    });
  } catch (err) {
    console.error("Error formatting products, error:", err);
    return [];
  }
};

// Format store meta info
const formatStoreMetaInfo = (metadata) => {
  if (!metadata) return [];

  const categories = new Set();

  const excluded = new Set([
    "Brands A - Z",
    "Trending Products",
    "New Products",
    "Category of the Month",
    "shipping upgrades",
    "upsell ajax",
  ]);

  const normalize = (name) =>
    name.replace(/&/g, "and").replace(/\s+/g, " ").trim();

  const walk = (node, isInsideBrandSection = false) => {
    const isBrandSection = isInsideBrandSection || node.name === "Brands A - Z";

    if (
      !isBrandSection &&
      node.is_active &&
      node.product_count > 0 &&
      !excluded.has(node.name)
    ) {
      categories.add(normalize(node.name));
    }

    node.children_data?.forEach((child) => walk(child, isBrandSection));
  };

  walk(metadata);

  return [...categories].sort();
};

// Fetch store metadata like product tags, types, collections, and categories
const storeMetadata = async () => {
  const cacheKey = "store_metadata";

  try {
    const cachedMetadata = await getCache(cacheKey);
    if (cachedMetadata) {
      return cachedMetadata;
    }

    const result = await callMagentoApi(
      "GET",
      "/categories?searchCriteria[currentPage]=1&searchCriteria[pageSize]=100",
    );

    if (!result) {
      return [];
    }

    const metadata = formatStoreMetaInfo(result);

    try {
      await setCache(cacheKey, metadata);
    } catch (cacheError) {
      console.warn(
        "storeMetadata cache set failed:",
        cacheError?.message || cacheError,
      );
    }

    return metadata;
  } catch (error) {
    console.error("productsMetadata Error:", error);

    return [];
  }
};

// Utility function to extract relevant search terms from a user query using OpenAI's language model. It uses the store metadata to generate more accurate and relevant search terms that can be used to query the product catalog.
const extractSearchTerms = async (query) => {
  if (!query || typeof query !== "string") {
    return [];
  }

  try {
    const metadata = await storeMetadata();

    const prompt = `You are an eCommerce search query generator.

    Given a user query and store catalog metadata, generate 3-4 short search queries to find relevant products.

    Rules:
    - Each query should contain a maximum of 2 words and can also be a single-word query.
    - Queries must look like real ecommerce catalog searches
    - Use catalog metadata to pick accurate product type terms
    - Never use conversational language
    - Return ONLY a JSON array of strings, nothing else

    Store Catalog Metadata:
    ${metadata}

    User Query: "${query}"

    Return format: ["query1", "query2", "query3"]`;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 100,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        timeout: 10000,
      },
    );

    const content = response?.data?.choices?.[0]?.message?.content?.trim();
    const cleaned = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((q) => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim().toLowerCase())
      .slice(0, 4);
  } catch (error) {
    console.error("extractSearchTerms Error:", error);
    return [];
  }
};

// Utility function to get sort option
const getProductSortConfig = (sortKey) => {
  const normalizedKey = String(sortKey || "").toLowerCase();

  return SORT_MAPPING[normalizedKey] || SORT_MAPPING[SortOption.RELEVANCE];
};

// Utility function to check courier is An Post based on order data
const isAnPostCourier = (order) => {
  if (!order) return false;

  // 1. Check status history comments (most reliable)
  const histories = order.status_histories || [];

  for (const h of histories) {
    const comment = (h.comment || "").toLowerCase();
    if (comment.includes("an post") || comment.includes("anpost")) {
      return true;
    }
  }

  // 2. Fallback: check shipping description
  const desc = (order.shipping_description || "").toLowerCase();
  if (desc.includes("an post") || desc.includes("anpost")) {
    return true;
  }

  return false;
};

// Utility function to determine financial status based on total paid and total due amounts
const getFinancialStatus = (order) => {
  if (!order) return "unknown";

  const totalPaid = order.total_paid || 0;
  const totalDue = order.total_due || 0;

  if (totalPaid > 0 && totalDue === 0) return "paid";
  if (totalPaid > 0 && totalDue > 0) return "partially_paid";
  if (totalPaid === 0) return "unpaid";

  return "unknown";
};

// Utility function to detect payment method
const getPaymentMethod = (order) => {
  const info = order.payment?.additional_information || [];
  return info.find((i) => typeof i === "string" && i.includes("Pay By")) || "";
};

// Utility function to get order tracking URL from status history comments
const getTrackingUrl = (order) => {
  const histories = order.status_histories || [];

  for (const h of histories) {
    const raw = h.comment || "";
    const comment = raw.toLowerCase();

    // ensure it's a tracking-related comment
    if (!comment.includes("tracking")) continue;

    // extract URL
    const match = raw.match(/https?:\/\/\S+/);
    if (match) return match[0];
  }

  return "";
};

// Utility function to format order data
const formatOrder = (order) => {
  // Format items
  const items = order.items.map((item) => ({
    item_id: item.item_id,
    product_id: item.product_id,
    name: item.name,
    quantity: item.qty_ordered,
    price: `${getCurrencySymbol(order?.base_currency_code)}${item.price_incl_tax}`,
  }));

  const orderData = {
    order_id: order.increment_id,
    financial_status: getFinancialStatus(order),
    fulfillment_status: order.state,
    email: order.customer_email,
    created_at: order.created_at,
    payment_gateways: getPaymentMethod(order),
    subtotal: `€${order.subtotal_incl_tax}`,
    discount: `€${order.discount_amount}`,
    tax: `€${order.shipping_incl_tax}`,
    total: `€${order.grand_total}`,
    order_url: `${MAGENTO_BASE_URL}sales/order/view/order_id/${order.entity_id}/`,
    tracking_url: getTrackingUrl(order),
    items: items,
  };

  return orderData;
};

// Utility function to format order payment transactions data
const formatOrderTransactions = (order) => {
  const payment = order.payment || {};

  const totalRefunded = order.items.reduce(
    (sum, item) => sum + (item.amount_refunded || 0),
    0,
  );

  const totalInvoiced = order.items.reduce(
    (sum, item) => sum + (item.row_invoiced || 0),
    0,
  );

  let billingAssessment = "No billing issues detected.";

  if (totalRefunded > 0) {
    billingAssessment =
      "One or more refunds have been processed for this order.";
  } else if (order.status === "pending") {
    billingAssessment =
      "Order is pending and payment may not have been completed or verified yet.";
  }

  return {
    order_id: order.increment_id,

    order_status: order.status,

    payment_method:
      order.extension_attributes?.payment_additional_info?.find(
        (x) => x.key === "method_title",
      )?.value || payment.method,

    payment_code: payment.method,

    total_amount: `${getCurrencySymbol(order.order_currency_code)}${order.grand_total}`,

    amount_ordered: `${getCurrencySymbol(order.order_currency_code)}${payment.amount_ordered}`,

    amount_refunded: `${getCurrencySymbol(order.order_currency_code)}${totalRefunded}`,

    amount_invoiced: `${getCurrencySymbol(order.order_currency_code)}${totalInvoiced}`,

    billing_assessment: billingAssessment,

    payment_summary: {
      invoiced: totalInvoiced > 0,

      refunded: totalRefunded > 0,

      pending: order.status === "pending",
    },
  };
};

// Utility function to format discounts rules
const formatDiscounts = (rules) => {
  if (!rules || !Array.isArray(rules)) return [];
  return (
    rules
      // Only active rules for the specified website
      .filter(
        (rule) =>
          rule.is_active &&
          Array.isArray(rule.website_ids) &&
          rule.website_ids.includes(WEBSITE_ID),
      )

      // Convert each rule to a human-readable summary
      .map((rule) => {
        const benefits = [];

        // Percentage discount
        if (rule.discount_amount > 0) {
          benefits.push(`${rule.discount_amount}% off`);
        }

        // Free shipping
        if (rule.simple_free_shipping === "1") {
          benefits.push("free shipping");
        }

        // Skip rules with no customer-visible benefit
        if (benefits.length === 0) {
          return null;
        }

        return {
          // Human readable title
          title: rule.name,

          // Short summary for LLM
          summary: `${rule.name}: ${benefits.join(" + ")}`,

          // Structured data if needed later
          benefits,

          couponRequired: rule.coupon_type === "SPECIFIC_COUPON",
        };
      })
      .filter(Boolean)
  );
};

// Export environment variables and utility functions
module.exports = {
  // envs
  MCP_NAME,
  MCP_VERSION,
  PORT,
  SMTP_USER,
  SMTP_PASS,
  BACKEND_API_URL,
  ZENDESK_API_URL,
  ZENDESK_USERNAME,
  ZENDESK_PASSWORD,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  SORT_CODE,
  SORT_DIR,
  // helpers
  callMagentoApi,
  callBackendAPI,
  logProductViewEvents,
  formatProducts,
  extractSearchTerms,
  getProductSortConfig,
  storeMetadata,
  isAnPostCourier,
  formatOrder,
  formatOrderTransactions,
  formatDiscounts,
};
