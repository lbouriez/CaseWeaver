-- PBI-016 workspace role-assignment lifecycle. Membership state is revisioned
-- as one workspace aggregate so concurrent administrator changes conflict.

CREATE TABLE workspace_role_assignment_states (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_role_assignment_revisions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  target_principal_id text NOT NULL,
  actor_principal_id text NOT NULL,
  previous_roles jsonb NOT NULL,
  current_roles jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, revision),
  FOREIGN KEY (workspace_id, target_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(previous_roles) = 'array'),
  CHECK (jsonb_typeof(current_roles) = 'array')
);
CREATE INDEX workspace_role_assignment_revisions_target_idx
  ON workspace_role_assignment_revisions (workspace_id, target_principal_id, revision DESC);

CREATE TABLE workspace_role_assignment_mutations (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  operation text NOT NULL,
  key_digest text NOT NULL,
  request_digest text NOT NULL,
  target_principal_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  previous_roles jsonb NOT NULL,
  current_roles jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation, key_digest),
  FOREIGN KEY (workspace_id, target_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(previous_roles) = 'array'),
  CHECK (jsonb_typeof(current_roles) = 'array')
);

CREATE OR REPLACE FUNCTION workspace_role_assignment_revisions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Workspace role assignment revisions are immutable';
END;
$$;
CREATE TRIGGER workspace_role_assignment_revisions_immutable_trigger
  BEFORE UPDATE OR DELETE ON workspace_role_assignment_revisions
  FOR EACH ROW EXECUTE FUNCTION workspace_role_assignment_revisions_immutable();

CREATE OR REPLACE FUNCTION workspace_role_assignment_mutations_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Workspace role assignment mutations are immutable';
END;
$$;
CREATE TRIGGER workspace_role_assignment_mutations_immutable_trigger
  BEFORE UPDATE OR DELETE ON workspace_role_assignment_mutations
  FOR EACH ROW EXECUTE FUNCTION workspace_role_assignment_mutations_immutable();

CREATE OR REPLACE FUNCTION workspace_role_assignments_retain_administrator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'administrator' AND NOT EXISTS (
    SELECT 1
    FROM workspace_role_assignments
    WHERE workspace_id = OLD.workspace_id
      AND role = 'administrator'
      AND (principal_id, role) <> (OLD.principal_id, OLD.role)
  ) THEN
    RAISE EXCEPTION 'A workspace must retain at least one administrator';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_role_assignments_retain_administrator_trigger
  BEFORE DELETE OR UPDATE ON workspace_role_assignments
  FOR EACH ROW EXECUTE FUNCTION workspace_role_assignments_retain_administrator();
