INSERT INTO character_inventory_resources(inventory_item_id,resource_definition_id,current_value,max_value)
SELECT inventory.id,definition.id,
  CASE WHEN definition.max_value_expression ~ '^\d+$' THEN definition.max_value_expression::integer ELSE 1 END,
  CASE WHEN definition.max_value_expression ~ '^\d+$' THEN definition.max_value_expression::integer ELSE 1 END
FROM character_inventory_items inventory
JOIN content_resource_definitions definition ON definition.content_id=inventory.source_content_id
ON CONFLICT(inventory_item_id,resource_definition_id) DO NOTHING;
