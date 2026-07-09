// Query to search products by a free-text `search` string.
// Supports:
//   - Price range filter ($priceMin / $priceMax) — pass "0"/"100000" as open-ended bounds.
//   - Stock-status filter is applied post-query in JS.
//   - Category filter ($categoryId) — conditionally added if hasCategory is true.
//   - Sort: name, price asc/desc, newest, or the store's default relevance sort.
//   - Aggregations (facets) — returned alongside items so the agent can offer refinements.
//   - Pagination metadata — total_count + page_info so the agent knows if more pages exist.
const buildProductSearchQuery = (hasCategory = false) => `query searchProducts(
    $search: String!
    $pageSize: Int!
    $currentPage: Int!
    $sortCode: String!
    $sortDir: SortEnum!
    $priceMin: String
    $priceMax: String
    ${hasCategory ? "$categoryId: String" : ""}
) {
    products(
        search: $search
        filter: {
            price: { from: $priceMin, to: $priceMax }
            ${hasCategory ? "category_id: { eq: $categoryId }" : ""}
        }
        sort: {
            mst_sort: {
                code: $sortCode
                dir: $sortDir
            }
        }
        pageSize: $pageSize
        currentPage: $currentPage
    ) {
        total_count
        page_info {
            current_page
            page_size
            total_pages
        }
        aggregations {
            attribute_code
            label
            count
            options {
                label
                value
                count
            }
        }
        items {
            id
            sku
            name
            type_id
            stock_status
            short_description { html }
            description { html }
            price {
                regularPrice {
                    amount {
                        value
                        currency
                    }
                }
            }
            special_price
            url_path
            url_key
            url_suffix
            categories { id name url_path level }
            media_gallery_entries { id file label position disabled }
            rating_summary
            review_count

            ... on CustomizableProductInterface {
                options {
                    title
                    required
                    sort_order
                    option_id
                    ... on CustomizableDropDownOption {
                        value {
                            option_type_id
                            price
                            price_type
                            sku
                            title
                            sort_order
                        }
                    }
                }
            }

            ... on ConfigurableProduct {
                configurable_options {
                    attribute_code
                    attribute_id
                    label
                    values { value_index label }
                }
                variants {
                    product {
                        id
                        sku
                        name
                        stock_status
                        price {
                            regularPrice {
                                amount {
                                    value
                                    currency
                                }
                            }
                        }
                        media_gallery_entries { file }
                    }
                    attributes { code value_index }
                }
            }
        }
    }
}`;

// Query to search products by SKU.
const productSearchBySKU = `query searchProducts($sku: String!) {
    products(filter: { sku: { eq: $sku } }) {
    items {
        id
        sku
        name
        type_id
        stock_status
        short_description { html }
        description { html }
        price {
        regularPrice {
            amount {
            value
            currency
            }
        }
        }
        special_price
        url_path
        url_key
        url_suffix
        categories { id name url_path level }
        media_gallery_entries { id file label position disabled }
        rating_summary
        review_count

        ... on CustomizableProductInterface {
        options {
            title
            required
            sort_order
            option_id
            ... on CustomizableDropDownOption {
            value {
                option_type_id
                price
                price_type
                sku
                title
                sort_order
            }
            }
        }
        }

        ... on ConfigurableProduct {
        configurable_options {
            attribute_code
            attribute_id
            label
            values { value_index label }
        }
        variants {
            product {
            id
            sku
            name
            stock_status
            price {
                regularPrice {
                amount {
                    value
                    currency
                }
                }
            }
            media_gallery_entries { file }
            }
            attributes { code value_index }
        }
        }
    }
    total_count
    }
}`;

// Export the GraphQL query for use in other modules
module.exports = {
  buildProductSearchQuery,
  productSearchBySKU,
};
