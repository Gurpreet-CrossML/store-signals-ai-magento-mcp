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
  ZENDESK_USERNAME,
  ZENDESK_PASSWORD,
  ZENDESK_API_URL,
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

// ######### 2. Fetch Products by ID #########
server.tool(
  "get_product_by_id",
  `Get detailed information about a product by its product ID.
  Returns product details including name, price, stock status, image URL, and more.
  Product ID are unique identifiers for products in Magento. These are not the same as product IDs or product names.
  Product ID are alphanumeric strings assigned to each product for identification and inventory management.
  
  Parameters:
  @param {number} product_id: The product ID of the product to retrieve.
  @param {string} store_code: Website store name/code.
  `,
  {
    product_id: z.number().describe("The product ID of the product"),
    store_code: z.string().describe("Store name/code"),
  },
  async ({ product_id, store_code }) => {
    try {
      const cacheKey = `product:${product_id}`;
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
        `/products?searchCriteria[filter_groups][0][filters][0][field]=entity_id&searchCriteria[filter_groups][0][filters][0][value]=${product_id}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`,
        null,
        store_code,
        false,
      );

      const product = response?.items?.[0];

      // If product not found, return an error message
      if (!product || !product?.sku) {
        return {
          content: [
            {
              type: "text",
              text: `Product with product id "${product_id}" not found.`,
            },
          ],
          isError: true,
        };
      }

      const graphqlQuery = {
        query: productSearchBySKU,
        variables: {
          sku: product?.sku,
        },
      };

      const productResponse = await callMagentoApi(
        "POST",
        "",
        graphqlQuery,
        store_code,
        true,
      );

      if (
        !productResponse?.data?.products?.items ||
        productResponse?.data?.products?.items?.length === 0
      ) {
        return {
          content: [
            {
              type: "text",
              text: `Product with product id "${product_id}" not found.`,
            },
          ],
          isError: true,
        };
      }

      // Format the search results
      const formattedResults = await formatProducts(
        productResponse?.data?.products?.items,
        true,
      );

      try {
        await setCache(cacheKey, formattedResults[0]);
      } catch (e) {
        console.warn("search cache set failed:", e?.message || e);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedResults[0], null, 2),
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

// ######### 8. Create Support Ticket #########
server.tool(
  "create_support_ticket",
  `Create a support ticket for a customer issue.

  Behavior:
  1. Check if requester exists by email.
  2. If not found, create new user.
  3. Create support ticket linked to requester.
  4. Return ticket ID in response.

  Parameters:
  - email (string): Customer email address
  - subject (string): Ticket subject line
  - description (string): Detailed problem description
  - session_id (string): Session ID
  - store_code (string): Store Code
  `,
  {
    email: z.string().email().describe("Customer email address"),
    subject: z.string().min(3).describe("Short ticket subject"),
    description: z.string().min(5).describe("Detailed issue description"),
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store Code"),
  },
  async ({ email, subject, description, session_id, store_code }) => {
    try {
      const authConfig = {
        auth: {
          username: `${ZENDESK_USERNAME}/token`,
          password: ZENDESK_PASSWORD,
        },
        headers: {
          "Content-Type": "application/json",
        },
      };

      let requesterId = null;

      // Search existing user
      const searchResponse = await axios.get(
        `${ZENDESK_API_URL}/users/search.json?query=${encodeURIComponent(email)}`,
        authConfig,
      );

      if (searchResponse?.data?.users?.length > 0) {
        requesterId = searchResponse.data.users[0].id;
      }

      // Create user if not found
      if (!requesterId) {
        const userResponse = await axios.post(
          `${ZENDESK_API_URL}/users.json`,
          {
            user: {
              name: email.split("@")[0],
              email: email,
            },
          },
          authConfig,
        );

        requesterId = userResponse?.data?.user?.id;
      }

      if (!requesterId) {
        return {
          content: [{ type: "text", text: "Unable to create requester user." }],
          isError: true,
        };
      }

      // Create ticket
      const ticketResponse = await axios.post(
        `${ZENDESK_API_URL}/tickets.json`,
        {
          ticket: {
            subject: subject,
            comment: {
              body: description,
            },
            requester_id: requesterId,
            priority: "normal",
          },
        },
        authConfig,
      );

      const ticketId = ticketResponse?.data?.ticket?.id;

      if (!ticketId) {
        return {
          content: [{ type: "text", text: "Failed to create support ticket." }],
          isError: true,
        };
      }

      const payload = {
        requester_id: requesterId,
        subject: subject,
        description: description,
        thread_id: session_id,
        store_code: store_code,
        ticket_id: ticketId,
      };

      callBackendAPI("POST", `/support/tickets/`, payload);

      // Success Response
      return {
        content: [
          {
            type: "text",
            text: `Support ticket #${ticketId} created successfully. Our team will contact you soon.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating support ticket: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 9. Order Transactions #########
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
