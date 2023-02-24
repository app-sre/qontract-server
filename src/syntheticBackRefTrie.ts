class SyntheticBackRefTrieNode {
  public readonly value: Set<string>;
  public readonly children: Map<string, SyntheticBackRefTrieNode>;

  constructor() {
    this.value = new Set();
    this.children = new Map();
  }

  insert(attrs: string[], data: any) {
    if (Array.isArray(data)) {
      for (const v of data) {
        this.insert(attrs, v);
      }
      return;
    }

    if (data == null || typeof data !== 'object') {
      return;
    }

    if (attrs.length === 0) {
      const v = data.$ref;
      if (v) {
        this.value.add(v);
      }
      return;
    }

    const [head, ...rest] = attrs;
    const attrVal = data[head];

    if (attrVal === undefined) {
      return;
    }

    const node = this.children.get(head);
    if (node !== undefined) {
      node.insert(rest, attrVal);
      return;
    }

    const newNode = new SyntheticBackRefTrieNode();
    newNode.insert(rest, attrVal);
    if (newNode.children.size > 0 || newNode.value.size > 0) {
      this.children.set(head, newNode);
    }
  }
}

export class SyntheticBackRefTrie {
  private readonly root: SyntheticBackRefTrieNode;

  constructor() {
    this.root = new SyntheticBackRefTrieNode();
  }

  insert(path: string, attrs: string[], data: any) {
    const node = this.root.children.get(path);

    if (node !== undefined) {
      node.insert(attrs, data);
      return;
    }

    const newNode = new SyntheticBackRefTrieNode();
    newNode.insert(attrs, data);
    if (newNode.children.size > 0 || newNode.value.size > 0) {
      this.root.children.set(path, newNode);
    }
  }

  contains(path: string, attrs: string[], ref: string): boolean {
    let node = this.root.children.get(path);
    for (const attr of attrs) {
      node = node?.children.get(attr);
    }
    return node === undefined ? false : node.value.has(ref);
  }
}
