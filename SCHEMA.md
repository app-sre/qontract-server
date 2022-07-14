# GraphQL Schema Documentation
The qontract-server implements different GraphQL types as per GraphQL [specification](https://spec.graphql.org/June2018/#sec-Types).

## Schema implementation
qontract-server relies on a schema definition document to implement different GraphQL types in Apollo Server. Here, we will explore how we create those types and what does some of the metadata associated with them means.

### Types
Currently, qontract-server on a high level supports [ObjectTypeDefinition](https://spec.graphql.org/June2018/#ObjectTypeDefinition) and [InterfaceTypeDefinition](https://spec.graphql.org/June2018/#InterfaceTypeDefinition) in addition to the primitive type definitions.

We implement GraphQL types in qontract-server through [schema.yml](https://github.com/app-sre/qontract-schemas/blob/main/graphql-schemas/schema.yml). This schema also adheres to a specific [json-schema](https://github.com/app-sre/qontract-schemas/blob/main/schemas/app-interface/graphql-schemas-1.yml).

Now, we will take a look at each attribute associated with a GraphQL type.

`name`: This is simply the name of GraphQL type. 

`fields`: This is a list of all fields associated with a type. The fields themselves adhere to specific [json-schema](https://github.com/app-sre/qontract-schemas/blob/main/schemas/app-interface/graphql-schemas-1.yml) that we will explore later in this document.

`datafile`: This attribute does not seem to be in used currently. 

`isInterface`: This attribute indicates whether a given type is a GraphQL interface or not. Absence of this field indicate the type assigned is ObjectTypeDefinition.

`interface`: This attribute lists the interface an object type is implementing.

`interfaceResolve`: This attribute is used to resolve object type that is implementing a given interface. This is necessary detail in [Apollo Server](https://www.apollographql.com/docs/apollo-server/schema/unions-interfaces/#resolving-an-interface) implementation.



### Fields
Fields associated with a given type can have different attributes. Let's explore each one of them.

`name`: This is simply the name associated with a field.

`type`: This attribute indicates the type of field. The type can be scalar/primitive such as `string`, `float`, `boolean`, `string`, `json` as well as object types such as `Cluster_v1`

`isInterface`: This attribute indicates whether a field is an interface. 

`isUnique`: This attribute is indicative of the unique constraint on the value. The enforcement for this is actually done through qontract-validator.

`isRequired`: This attribute indicates that the type is non-null i.e values are never null and an error can be raised during the request if they are not.

`isSearchable`: This attribute allows to search/filter results based on the string argument. For e.g App_v1.name is searchable attribute and we can do a query 

`isList`: This attribute indicates a list of values with a specific type indicated by `type` attribute. 

`isResource`: This attribute is used for fields of type Resource_v1 or string. If the type of the field i Resource_v1, a query for the field resolves to proper resource object. If the type of the field is string, the field is considered a resource reference, basically just the path to a resource.

`resolveResource`: This attribute can be put on a resource reference field (isResource: true and type: string) to replace fetching the path of an object with the actual resource object. This enables resource fetching without breaking schema changes

`synthetic`: This attribute is used to set up backward references following a schema references back to the parent, e.g.

```yaml
synthetic:
  schema: /parent-schema-1.yml,
  subAttr: path to the field in the parent schema that points to >this< schema using . (dot) as path delimiter
```

`datafileSchema`: This attribute is used during filtering to ensure the query result is of required schema.
