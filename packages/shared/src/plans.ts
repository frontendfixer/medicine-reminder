// Patient limit per plan, derived on the server from the plan, never from the client.
// Source: docs/07-subscriptions-and-billing.md#plans. Other plans, prices and any trial are OI-01.
export const PLAN_PATIENT_LIMIT = { starter: 3 } as const;

export type PlanId = keyof typeof PLAN_PATIENT_LIMIT;
