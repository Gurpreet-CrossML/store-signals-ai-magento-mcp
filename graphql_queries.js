// Query to search products by a free-text `search` string.
const productSearchByQuery = `query searchProducts($search: String!, $pageSize: Int!, $currentPage: Int!, $sortCode: String!, $sortDir: SortEnum!) {
    products(
        search: $search
        sort: {
            mst_sort: {
                code: $sortCode,
                dir: $sortDir
            }
        }
        pageSize: $pageSize
        currentPage: $currentPage
    ) {
        items {
        id
        sku
        name
        type_id
        stock_status
        short_description { html }
        description {html}
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

// Query to search a single product by name against the Magento catalog.
// Uses the same field shape as productSearchByQuery but accepts only a search
// string — no sort / pagination variables required for a simple name lookup.
const productSearchByName = `query searchProductByName($search: String!) {
  products(
    search: $search
    pageSize: 5
    currentPage: 1
  ) {
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
  productSearchByQuery,
  productSearchBySKU,
  productSearchByName,
};
