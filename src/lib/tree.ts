/** 将 parentId 链表展平记录转为嵌套树（支持任意深度） */

export type TreeNode<T extends { id: string; parentId: string | null }> = T & {
  children: TreeNode<T>[];
};

export function buildTree<
  T extends { id: string; parentId: string | null; sortOrder?: number },
>(items: T[]): TreeNode<T>[] {
  const map = new Map<string, TreeNode<T>>();
  for (const item of items) {
    map.set(item.id, { ...item, children: [] });
  }
  const roots: TreeNode<T>[] = [];
  for (const item of items) {
    const node = map.get(item.id)!;
    if (item.parentId && map.has(item.parentId)) {
      map.get(item.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (nodes: TreeNode<T>[]) => {
    nodes.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}
