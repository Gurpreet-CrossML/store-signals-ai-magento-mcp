const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const {
  productSearchByQuery,
  productSearchBySKU,
} = require("./graphql_queries");
const {
  MCP_NAME,
  MCP_VERSION,
  PORT,
  SMTP_USER,
  SMTP_PASS,
  SORT_CODE,
  SORT_DIR,
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
  formatRefundStatus,
} = require("./utils");

const { getCache, setCache } = require("./cache");

// Initialize the MCP server
const server = new McpServer({
  name: MCP_NAME,
  version: MCP_VERSION,
  capabilities: {
    tools: true,
    resources: true,
  },
});

// Configure Nodemailer transporter for sending OTP emails using SMTP credentials from environment variables.
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// ********************************** MCP Tools **********************************
// ######### 1. Search Products #########
server.tool(
  "search_products",
  `Search for products based on the user's query. 
  Returns a list of products with their details, including name, price, stock status, and image URL.
  Supports pagination with page size and current page parameters.

  Parameters:
  @param {string} query: The search query (product name, description, etc.)
  @param {int} page_size: Number of results per page (default: 4)
  @param {int} current_page: Page number (default: 1)
  @param {string} session_id: Session ID
  @param {string} store_code: Store name or code
  @param {boolean} full_details: 
  `,
  {
    query: z
      .string()
      .describe("Search query (product name, description, etc.)"),
    page_size: z
      .number()
      .optional()
      .describe("Number of results per page (default: 4)"),
    current_page: z.number().optional().describe("Page number (default: 1)"),
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store name/code"),
    full_details: z
      .boolean()
      .optional()
      .describe(
        "Whether to return full product details including variants, images, and URLs. Defaults to false.",
      ),
  },
  async ({
    query,
    session_id,
    store_code,
    page_size = 4,
    current_page = 1,
    full_details = false,
  }) => {
    try {
      const cacheKey = `search:${query}:${full_details ? "full" : "brief"}`;
      const cached = await getCache(cacheKey);
      if (cached) {
        logProductViewEvents(cached.products, session_id, store_code);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cached, null, 2),
            },
          ],
        };
      }

      const graphqlQuery = {
        query: productSearchByQuery,
        variables: {
          search: query,
          sortCode: SORT_CODE,
          sortDir: SORT_DIR,
          pageSize: page_size,
          currentPage: current_page,
        },
      };

      // Call Magento API to search products
      const searchResponse = await callMagentoApi(
        "POST",
        "",
        graphqlQuery,
        store_code,
        true,
      );

      // Format the products data to be returned
      let formattedProducts = formatProducts(
        searchResponse?.data?.products?.items || [],
        full_details,
      );

      // Final response object to be returned, which may include related products if found.
      const result = {
        products: formattedProducts,
      };

      // If no products found with the initial query, try extracting keywords and searching again.
      if (result?.products?.length === 0) {
        const keywords = await extractSearchTerms(query);
        console.log(
          `No products found for this query "${query}", retrying with keywords - [${keywords}]...`,
        );

        for (let q of keywords) {
          const gQuery = {
            query: productSearchByQuery,
            variables: {
              search: q,
              sortCode: SORT_CODE,
              sortDir: SORT_DIR,
            },
          };

          const searchResponse = await await callMagentoApi(
            "POST",
            "",
            gQuery,
            store_code,
            true,
          );

          if (
            searchResponse?.data?.products?.items &&
            searchResponse?.data?.products?.items?.length > 0
          ) {
            const formattedProducts = formatProducts(
              searchResponse?.data?.products?.items,
              full_details,
            );

            result.products = formattedProducts;
            break;
          }
        }
      }

      try {
        await setCache(cacheKey, result);
      } catch (e) {
        console.warn("search cache set failed:", e?.message || e);
      }

      // Log product view event to backend for analytics
      logProductViewEvents(result.products, session_id, store_code);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching products: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 2. Fetch Products by IDs #########
server.tool(
  "get_product_by_ids",
  `Get detailed information about multiple products by product IDs.

  Parameters:
  @param {string[]} product_ids: Array of Magento product IDs.
  @param {string} store_code: Website store name/code.
  `,
  {
    product_ids: z.array(z.string()).describe("Array of Magento product IDs"),
    store_code: z.string().describe("Store name/code"),
  },
  async ({ product_ids, store_code }) => {
    try {
      const results = [];
      for (const product_id of product_ids) {
        const cacheKey = `product:${product_id}`;

        // Check cache first
        const cached = await getCache(cacheKey);
        if (cached) {
          results.push(cached);
          continue;
        }

        try {
          const response = await callMagentoApi(
            "GET",
            `/products?searchCriteria[filter_groups][0][filters][0][field]=entity_id&searchCriteria[filter_groups][0][filters][0][value]=${product_id}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`,
            null,
            store_code,
            false,
          );

          const product = response?.items?.[0];

          if (!product?.sku) {
            continue;
          }

          const graphqlQuery = {
            query: productSearchBySKU,
            variables: {
              sku: product.sku,
            },
          };

          const productResponse = await callMagentoApi(
            "POST",
            "",
            graphqlQuery,
            store_code,
            true,
          );

          const graphqlProduct = productResponse?.data?.products?.items?.[0];

          if (!graphqlProduct) {
            continue;
          }

          const formattedProducts = await formatProducts(
            [graphqlProduct],
            true,
          );

          const formattedProduct = formattedProducts?.[0];

          if (formattedProduct) {
            results.push(formattedProduct);

            try {
              await setCache(cacheKey, formattedProduct);
            } catch (e) {
              console.warn("product cache set failed:", e?.message || e);
            }
          }
        } catch (err) {
          console.warn(
            `Failed to fetch product ${product_id}:`,
            err?.message || err,
          );
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ products: results }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching product: ${error?.message || error}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 3. Fetch Sorted Products #########
server.tool(
  "get_products_sorted",
  `Fetch up to 5 products, sorted by Magento sort options. Supported sort keys: relevance, price_asc, price_desc, best_rating, best_selling.

  Parameters:
  @param {string} session_id: Session ID
  @param {string} store_code: Store name or code
  @param {string} [sort_key]: Sort key. Supported values: relevance, price_asc, price_desc, best_rating, best_selling.
  `,
  {
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store name/code"),
    sort_key: z.string().describe("Sort key for the product list"),
  },
  async ({ session_id, store_code, sort_key }) => {
    try {
      const cacheKey = `get_products_sorted:${String(sort_key || "relevance")}`;
      const cached = await getCache(cacheKey);
      if (cached) {
        logProductViewEvents(cached.products, session_id, store_code);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cached, null, 2),
            },
          ],
        };
      }

      const { sortCode, sortDir } = getProductSortConfig(sort_key);

      const graphqlQuery = {
        query: productSearchByQuery,
        variables: {
          search: "",
          pageSize: 5,
          currentPage: 1,
          sortCode: sortCode,
          sortDir: sortDir,
        },
      };

      const response = await callMagentoApi(
        "POST",
        "",
        graphqlQuery,
        store_code,
        true,
      );

      if (!response?.data?.products) {
        return {
          content: [
            {
              type: "text",
              text: "No products found",
            },
          ],
        };
      }

      const formattedProducts = formatProducts(response?.data?.products?.items);

      const result = { products: formattedProducts };

      try {
        await setCache(cacheKey, result);
      } catch (cacheError) {
        console.warn(
          "get_products_sorted cache set failed:",
          cacheError?.message || cacheError,
        );
      }

      logProductViewEvents(result.products, session_id, store_code);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching sorted products: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 4. Fetch Store Metadata #########
server.tool(
  "get_store_meta_info",
  `Fetch metadata about the store's product catalog.
  Returns product tags, types, collections, and categories available in the store.
  `,
  async () => {
    try {
      const metadata = await storeMetadata();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(metadata, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching store metadata: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 5. Send OTP #########
server.tool(
  "send_otp",
  `Send a verification OTP to the provided email. 
  Required for guest users to verify identity before tracking orders. 
  This tool is only for guest users and only when tracking orders.

  Parameters:
  @param {string} email - User email to receive OTP
  @param {string} session_id - Unique session identifier
  `,
  {
    email: z.string().email().describe("User email address"),
    session_id: z.string().min(5).describe("Unique session identifier"),
  },
  async ({ email, session_id }) => {
    try {
      const verificationStatus = await callBackendAPI(
        "POST",
        "/chat/email/verify-status/",
        { thread_id: session_id, email: email },
      );
      if (verificationStatus && verificationStatus?.is_verified) {
        return {
          content: [{ type: "text", text: "Your email is already verified." }],
          isError: false,
        };
      }

      // Criteria to search for customer by email
      const searchCriteria =
        `searchCriteria[filter_groups][0][filters][0][field]=email&` +
        `searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(email)}&` +
        `searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;

      // Call Magento API to search for customer by email
      const customerResponse = await callMagentoApi(
        "GET",
        `/customers/search?${searchCriteria}`,
      );

      // If no customer found, return an error message
      if (!customerResponse || customerResponse.total_count === 0) {
        return {
          content: [{ type: "text", text: "No account found with this email" }],
          isError: true,
        };
      }

      const otpResponse = await callBackendAPI("POST", "/chat/otp/generate/", {
        thread_id: session_id,
        email: email,
      });

      if (!otpResponse || !otpResponse?.otp) {
        return {
          content: [
            { type: "text", text: "Failed to send otp, please try again." },
          ],
          isError: true,
        };
      }

      // Send email
      await transporter.sendMail({
        from: `"Magento Support" <${process.env.SMTP_USER}>`,
        to: email,
        subject: "Your verification code",
        text: `Your verification code is ${otpResponse?.otp}. It will expire in ${otpResponse?.expires_in_seconds} seconds.`,
      });

      return {
        content: [
          {
            type: "text",
            text: "A 6-digit verification code has been sent to your email.",
          },
        ],
      };
    } catch (error) {
      console.error("Send OTP error:", error);
      return {
        content: [
          { type: "text", text: "Unable to send verification code right now." },
        ],
        isError: true,
      };
    }
  },
);

// ######### 6. Verify OTP #########
server.tool(
  "verify_otp",
  `Verify an OTP sent for order tracking email verification.

  Parameters:
  @param {string} email - User email used for verification
  @param {string} otp_code - 6 digit OTP
  @param {string} session_id - Session identifier
  `,
  {
    email: z.string().email().describe("User email"),
    otp_code: z.string().length(6).describe("6 digit OTP"),
    session_id: z.string().describe("Session identifier"),
  },
  async ({ email, otp_code, session_id }) => {
    try {
      const payload = {
        thread_id: session_id,
        email: email,
        otp: otp_code,
      };
      const verificationResponse = await callBackendAPI(
        "POST",
        "/chat/otp/verify/",
        payload,
      );

      if (!verificationResponse || !verificationResponse?.is_verified) {
        return {
          content: [
            { type: "text", text: "Invalid or expired verification code." },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: "Verification successful." }],
        verified: true,
      };
    } catch (error) {
      console.error("Verify OTP error:", error);
      return {
        content: [
          { type: "text", text: "Verification failed. Please try again." },
        ],
        isError: true,
      };
    }
  },
);

// ######### 7. Get Order Detail #########
server.tool(
  "get_order_detail",
  `Fetch a specific order by order number and email.
  Returns a single order object.

  Parameters:
  @param {string} email: Order identifier (e.g. "test@example.com")
  @param {number} order_id: The unique ID of the order to track. Order ID must be exactly 10 digits long.
  @param {string} session_id - Session identifier
  @param {string} customer_id - Customer ID
  `,
  {
    email: z.string().describe("Order email (e.g. 'test@example.com')"),
    order_id: z
      .number()
      .describe(
        "The unique ID of the order to track. Order ID must be exactly 10 digits long",
      ),
    session_id: z.string().describe("Session identifier"),
    customer_id: z.string().optional().describe("Customer ID"),
  },
  async ({ email, order_id, session_id, customer_id = "" }) => {
    // Validate Order ID
    if (order_id <= 0 || String(order_id).length !== 10) {
      return {
        content: [
          { type: "text", text: "Order ID must be exactly 10 digits long." },
        ],
        isError: true,
      };
    }

    if (!customer_id) {
      const verificationStatus = await callBackendAPI(
        "POST",
        "/chat/email/verify-status/",
        { thread_id: session_id, email: email },
      );

      if (!verificationStatus && !verificationStatus?.is_verified) {
        return {
          content: [
            {
              type: "text",
              text: "Please verify your email before accessing order details.",
            },
          ],
          isError: true,
        };
      }
    }

    try {
      const endpoint = `/orders?searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${order_id}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;

      // Call Magento API to fetch order details
      const apiResponse = await callMagentoApi("GET", endpoint);
      const order = apiResponse?.items?.[0];

      // If no order found, return an error message
      if (!order) {
        return {
          content: [
            {
              type: "text",
              text: `We couldn't find an order with the number #${order_id}. Please check the order number and try again.`,
            },
          ],
          isError: true,
        };
      }

      // If no order found with the given email, return an error message
      if (order?.customer_email !== email) {
        return {
          content: [
            {
              type: "text",
              text: "We couldn't find an order matching the provided order number and email address. Please verify both details and try again.",
            },
          ],
          isError: true,
        };
      }

      let isPostCourier = isAnPostCourier(order);

      if (!isPostCourier) {
        return {
          content: [
            {
              type: "text",
              text: "This order is shipped via UPS, and we usually send the tracking details to your email after dispatch. Please check your inbox (and spam folder) for the tracking update.",
            },
          ],
        };
      }

      const formattedOrder = formatOrder(order);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedOrder, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching order detail: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 8. Order Transactions #########
server.tool(
  "get_order_transactions",
  `Fetch payment transactions for a specific order.

  Returns a payment investigation summary that can be used
  to identify duplicate charges, authorization holds,
  refunds, captures, and other billing issues.

  Parameters:
  @param {string} email
  @param {number} order_id
  @param {string} session_id
  @param {string} customer_id
  `,
  {
    email: z.string().describe("Order email"),
    order_id: z.number().describe("Order ID"),
    session_id: z.string().describe("Session identifier"),
    customer_id: z.string().optional().describe("Customer ID"),
  },
  async ({ email, order_id, session_id, customer_id = "" }) => {
    try {
      // Verify email first
      if (!customer_id) {
        const verificationStatus = await callBackendAPI(
          "POST",
          "/chat/email/verify-status/",
          {
            thread_id: session_id,
            email,
          },
        );

        if (!verificationStatus?.is_verified) {
          return {
            content: [
              {
                type: "text",
                text: "Please verify your email before accessing payment information.",
              },
            ],
            isError: true,
          };
        }
      }

      const endpoint = `/orders?searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${order_id}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;

      // Call Magento API to fetch order details
      const apiResponse = await callMagentoApi("GET", endpoint);
      const order = apiResponse?.items?.[0];

      // If no order found, return an error message
      if (!order) {
        return {
          content: [
            {
              type: "text",
              text: `We couldn't find an order with the number #${order_id}. Please check the order number and try again.`,
            },
          ],
          isError: true,
        };
      }

      // If no order found with the given email, return an error message
      if (order?.customer_email !== email) {
        return {
          content: [
            {
              type: "text",
              text: "We couldn't find an order matching the provided order number and email address. Please verify both details and try again.",
            },
          ],
          isError: true,
        };
      }

      const formattedTransactions = formatOrderTransactions(order);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedTransactions, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching order transactions: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 9. List Available Discounts #########
server.tool(
  "list_available_discounts",
  `List all available discounts from the store.
  Returns active discount codes, automatic discounts (price rules), and their details.
  `,
  {
    page: z.number().optional().default(1),
    pageSize: z.number().optional().default(20),
  },
  async ({ page = 1, pageSize = 20 }) => {
    try {
      const cacheKey = `available_discounts:${page}:${pageSize}`;
      const cached = await getCache(cacheKey);
      if (cached) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cached, null, 2),
            },
          ],
        };
      }

      const response = await callMagentoApi(
        "GET",
        `/salesRules/search?searchCriteria[filter_groups][0][filters][0][field]=is_active&searchCriteria[filter_groups][0][filters][0][value]=1&searchCriteria[filter_groups][0][filters][0][condition_type]=eq&searchCriteria[currentPage]=${page}&searchCriteria[pageSize]=${pageSize}`,
      );

      if (!response?.items || response?.items?.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No discounts found.",
            },
          ],
        };
      }

      const discounts = formatDiscounts(response?.items);

      if (discounts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No discounts found.",
            },
          ],
        };
      }

      const payload = {
        page,
        pageSize,
        total: response.total_count,
        totalPages: Math.ceil(response.total_count / pageSize),
        hasNextPage: page * pageSize < response.total_count,
        nextPage: page * pageSize < response.total_count ? page + 1 : null,
        discounts,
      };

      try {
        await setCache(cacheKey, payload);
      } catch (cacheError) {
        console.warn(
          "available_discounts cache set failed:",
          cacheError?.message || cacheError,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Error fetching discounts:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error fetching available discounts: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);
// ######### 10. Get Order Refund Status #########
server.tool(
  "get_refund_status",
  `Fetch the refund status of a specific order by order number and customer email.

  Returns one of the following statuses:
    - NOT_REFUNDED       : No refunds exist on this order
    - FULLY_REFUNDED     : Order has been fully refunded
    - PARTIALLY_REFUNDED : Order has been partially refunded
    - REFUND_PENDING     : A refund is initiated but not yet settled
    - REFUND_FAILED      : All refund attempts were cancelled

  Parameters:
  @param {string} email       - Customer email associated with the order
  @param {number} order_id    - 10-digit order number (e.g. 1234567890)
  @param {string} session_id  - Session identifier
  @param {string} customer_id - Customer ID (optional; skips email verification if provided)
  `,
  {
    email: z.string().email().describe("Customer email address"),
    order_id: z
      .number()
      .describe("10-digit order number (e.g. 1234567890)"),
    session_id: z.string().describe("Session identifier"),
    customer_id: z
      .string()
      .optional()
      .describe("Customer ID (optional, pass empty string if unknown)"),
  },
  async ({ email, order_id, session_id, customer_id = "" }) => {
    try {
      // 1. Email verification (skipped when customer_id is known)
      if (!customer_id) {
        const verificationStatus = await callBackendAPI(
          "POST",
          "/chat/email/verify-status/",
          { thread_id: session_id, email },
        );

        if (!verificationStatus?.is_verified) {
          return {
            content: [
              {
                type: "text",
                text: "Please verify your email before accessing refund information.",
              },
            ],
            isError: true,
          };
        }
      }

      // 2. Fetch the order by increment_id
      const endpoint =
        `/orders?searchCriteria[filter_groups][0][filters][0][field]=increment_id` +
        `&searchCriteria[filter_groups][0][filters][0][value]=${order_id}` +
        `&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;

      const apiResponse = await callMagentoApi("GET", endpoint);
      const order = apiResponse?.items?.[0];

      if (!order) {
        return {
          content: [
            {
              type: "text",
              text: `We couldn't locate order #${order_id}. Please verify the order number and try again.`,
            },
          ],
          isError: true,
        };
      }

      // 3. Validate email ownership
      if (order.customer_email !== email) {
        return {
          content: [
            {
              type: "text",
              text: "We couldn't find an order matching the provided order number and email address. Please verify both details and try again.",
            },
          ],
          isError: true,
        };
      }

      // 4. Fetch credit memos (refunds) for this order
      const refundsResponse = await callMagentoApi(
        "GET",
        `/orders/${order.entity_id}/refunds`,
      );

      // Magento returns an array directly, not wrapped in { items: [] }
      const creditMemos = Array.isArray(refundsResponse)
        ? refundsResponse
        : (refundsResponse?.items ?? []);

      // 5. Format and return
      const payload = formatRefundStatus(order, creditMemos);

      console.log(
        `get_refund_status: order_id=${order_id} | status=${payload.refund_status} | session=${session_id}`,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("get_refund_status error:", error.message);
      return {
        content: [
          {
            type: "text",
            text: `Unable to retrieve refund details for order #${order_id}. Please try again later.`,
          },
        ],
        isError: true,
      };
    }
  },
);
// ********************************** End of MCP Tools **********************************

// Start the server
const app = express();
app.use(express.json());

// Enable CORS for all routes and origins to allow cross-origin requests from any client, which is essential for the MCP server to be accessible from different domains and frontend applications without CORS issues.
app.use(
  cors({
    origin: "*",
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

// Handle incoming MCP requests at the /mcp endpoint, connecting them to the MCP server transport layer. This allows the server to process JSON-RPC requests sent to /mcp and route them to the appropriate tools defined in the MCP server.
app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      console.log("Request closed");
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// Explicitly disallow GET and DELETE methods on the /mcp endpoint to ensure that only POST requests are accepted, which is important for maintaining the integrity of the MCP server's JSON-RPC communication and preventing unintended access or operations through unsupported HTTP methods.
app.get("/mcp", async (req, res) => {
  console.log("Received GET MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }),
  );
});
app.delete("/mcp", async (req, res) => {
  console.log("Received DELETE MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }),
  );
});

// Start the Express server on the specified port, and log a message indicating that the MCP Stateless Streamable HTTP Server is listening. If there is an error during startup, it will be logged and the process will exit with a failure code.
app.listen(PORT, (error) => {
  if (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
  console.log(`MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
});
