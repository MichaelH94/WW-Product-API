import { idToGid } from "../utils/gid";

export interface FAQ {
  question: string;
  answer: string;
  show_on_faq_page: boolean;
}

export type FAQSummary = FAQ & { id: string };

function gqlFetch(query: string, variables?: Record<string, unknown>) {
  return fetch("shopify:admin/api/2026-07/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  }).then((r) => r.json());
}

type FAQValues = { [K in keyof FAQ]?: FAQ[K] | null };

function fromValues(values: FAQValues): FAQ {
  return {
    question: values.question ?? "",
    answer: values.answer ?? "",
    show_on_faq_page: values.show_on_faq_page ?? true,
  };
}

export async function fetchFAQ(id: string): Promise<FAQ> {
  const json = await gqlFetch(
    `#graphql
    query FAQ($id: ID!) {
      metaobject(id: $id) {
        values
      }
    }`,
    { id: idToGid(id) },
  );

  const faq = fromValues(json.data.metaobject.values);
  return faq;
}

export async function listFAQs(): Promise<FAQSummary[]> {
  const json = await gqlFetch(
    `#graphql
    query FAQs {
      metaobjects(type: "$app:faq", first: 50, sortKey: "updated_at", reverse: true) {
        edges {
          node {
            id
            values
          }
        }
      }
    }`,
  );

  const faqs = json.data.metaobjects.edges.map(
    ({
      node,
    }: {
      node: { id: string; values: FAQValues };
    }) => ({
      id: node.id,
      ...fromValues(node.values),
    }),
  );

  return faqs;
}
