-- PBI-016 budget policies are selected by scope *and* currency.  A workspace
-- may therefore retain one active policy per currency for the same scope/key;
-- collapsing currencies would make a valid provider test or AI operation fail
-- before the pricing/budget layer can select its matching policy.
DROP INDEX ai_budget_policies_one_active_scope_idx;

CREATE UNIQUE INDEX ai_budget_policies_one_active_scope_currency_idx
  ON ai_budget_policies (workspace_id, scope, scope_key, currency)
  WHERE active;
