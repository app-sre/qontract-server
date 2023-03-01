import { Collection, Seq } from 'immutable';
import { Datafile, GraphQLSchemaType } from './types';

class TrieNode {
  public readonly value: Map<string, Set<Datafile>>;
  public readonly children: Map<string, TrieNode>;

  constructor() {
    this.value = new Map();
    this.children = new Map();
  }

  insert(keys: string[], data: any, value: Datafile) {
    if (Array.isArray(data)) {
      for (const d of data) {
        this.insert(keys, d, value);
      }
      return;
    }

    if (keys.length === 0) {
      if (typeof data !== 'string') {
        return;
      }
      const values = this.value.get(data);
      if (values === undefined) {
        this.value.set(data, new Set([value]));
      } else {
        values.add(value);
      }
      return;
    }

    const [head, ...rest] = keys;
    if (!(head in data)) {
      return;
    }
    const attrVal = data[head];
    const node = this.children.get(head);
    if (node !== undefined) {
      node.insert(rest, attrVal, value);
      return;
    }

    const newNode = new TrieNode();
    newNode.insert(rest, attrVal, value);
    if (newNode.children.size > 0 || newNode.value.size > 0) {
      this.children.set(head, newNode);
    }
  }
}

export class SyntheticBackRefTrie {
  private readonly root: TrieNode;

  constructor() {
    this.root = new TrieNode();
  }

  insert(schema: string, attrs: string[], data: Datafile) {
    const keys = [schema, ...attrs, '$ref'];
    this.root.insert(keys, { [schema]: data }, data);
  }

  private find(keys: string[]): TrieNode | undefined {
    let node = this.root;
    for (const key of keys) {
      node = node.children.get(key);
      if (node === undefined) {
        return undefined;
      }
    }
    return node;
  }

  getDatafiles(schema: string, attrs: string[], path: string): Datafile[] {
    const keys = [schema, ...attrs, '$ref'];
    const node = this.find(keys);
    if (node === undefined) {
      return [];
    }
    const datafiles = node.value.get(path);
    return datafiles === undefined ? [] : Array.from(datafiles);
  }
}

const getSyntheticFieldSubAttrsBySchema = (
  schema: GraphQLSchemaType | any[],
): Map<string, Set<string>> => {
  const syntheticFieldSubAttrs = new Map<string, Set<string>>();
  const schemaData = 'confs' in schema && schema.confs ? schema.confs : schema as any[];
  for (const conf of schemaData) {
    for (const fieldInfo of conf.fields) {
      if (fieldInfo.synthetic) {
        const key = fieldInfo.synthetic.schema;
        const value = fieldInfo.synthetic.subAttr;
        const subAttrs = syntheticFieldSubAttrs.get(key);
        if (subAttrs === undefined) {
          syntheticFieldSubAttrs.set(key, new Set([value]));
        } else {
          subAttrs.add(value);
        }
      }
    }
  }
  return syntheticFieldSubAttrs;
};

export const buildSyntheticBackRefTrie = (
  datafilesBySchema: Seq.Keyed<string, Collection<string, Datafile>>,
  schema: GraphQLSchemaType | any[],
): SyntheticBackRefTrie => {
  const syntheticBackRefTrie = new SyntheticBackRefTrie();
  const syntheticFieldSubAttrsBySchema = getSyntheticFieldSubAttrsBySchema(schema);
  syntheticFieldSubAttrsBySchema.forEach((subAttrs: Set<string>, s: string) => {
    (datafilesBySchema.get(s) || []).forEach((df: Datafile) => {
      for (const subAttr of subAttrs) {
        syntheticBackRefTrie.insert(s, subAttr.split('.'), df);
      }
    });
  });
  return syntheticBackRefTrie;
};
