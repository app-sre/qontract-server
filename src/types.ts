export type Datafile = {
  $schema: string;
  path: string;
  [key: string]: any;
};

export type GraphQLSchemaType = {
  $schema: string;
  confs: any[];
};
