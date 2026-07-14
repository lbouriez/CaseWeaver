import { Datagrid, List, Show, SimpleShowLayout, TextField } from "react-admin";

export function AdminResourceList() {
  return (
    <List perPage={25} sort={{ field: "updatedAt", order: "DESC" }}>
      <Datagrid bulkActionButtons={false} rowClick="show">
        <TextField source="label" />
        <TextField source="status" />
        <TextField source="version" />
        <TextField source="updatedAt" />
      </Datagrid>
    </List>
  );
}

export function AdminResourceShow() {
  return (
    <Show>
      <SimpleShowLayout>
        <TextField source="label" />
        <TextField source="status" />
        <TextField source="version" />
        <TextField source="updatedAt" />
        <TextField source="summary" />
      </SimpleShowLayout>
    </Show>
  );
}
