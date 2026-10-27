import { NEWSLETTER_TOPIC } from "../src/delivery/deliver.ts";

// Resend as delivery uses it, in memory: a segment of contacts listed in pages, each contact's topics and properties, and every
// email sent recorded with the idempotency key it carried.
export function fakeResend(contacts, options = {}) {
  const sent = [];
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const optedOut = new Set(options.optedOut ?? []);
  const client = {
    contacts: {
      list: async ({ limit, after }) => {
        const start = after ? contacts.findIndex((contact) => contact.id === after) + 1 : 0;
        const page = contacts.slice(start, start + limit);
        return { data: { data: page.map(({ id, email, firstName, unsubscribed }) => ({ id, email, first_name: firstName ?? null, unsubscribed: !!unsubscribed })), has_more: start + limit < contacts.length }, error: null };
      },
      get: async ({ id }) => {
        const contact = byId.get(id);
        return contact ? { data: { id, email: contact.email, unsubscribed: !!contact.unsubscribed, properties: Object.fromEntries(Object.entries(contact.properties ?? {}).map(([key, value]) => [key, { type: "string", value }])) }, error: null } : { data: null, error: { name: "not_found", message: "not found" } };
      },
      topics: { list: async ({ email }) => ({ data: { data: optedOut.has(email) ? [] : [{ id: NEWSLETTER_TOPIC, subscription: "opt_in" }] }, error: null }) },
    },
    emails: { send: async (payload, config) => { sent.push({ ...payload, idempotencyKey: config?.idempotencyKey }); return { data: { id: `email-${sent.length}` }, error: null }; } },
  };
  return { client, sent };
}

/** Steps that store each result as JSON, as Workflows does. */
export const jsonSteps = (names = []) => ({ run: async (name, config, callback) => { names.push(name); return JSON.parse(JSON.stringify(await callback())); }, sleep: async () => {} });

export const reader = (n, properties = {}, extra = {}) => ({ id: `c${n}`, email: `reader${n}@example.com`, firstName: `Reader${n}`, properties, ...extra });
export const PROFILE = (extra = {}) => JSON.stringify({ firstName: "Ada", lastName: "L", role: "ML engineer", seniority: "Senior", company: "Acme", topics: ["Agents"], content: ["News", "Models", "Repos"], format: "Briefing", notes: "", ...extra });
export const PERSONAL = (extra = {}) => ({ personal_status: "active", personal_plan: "personal", onboarding_profile: PROFILE(extra) });
export const PROFESSIONAL = (extra = {}) => ({ personal_status: "active", personal_plan: "professional", onboarding_profile: PROFILE(extra) });
