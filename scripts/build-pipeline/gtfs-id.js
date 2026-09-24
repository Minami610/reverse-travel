/**
 * gtfs-id.js - stop_id/route_id の名前空間化
 *
 * GTFSのstop_id/route_idはフィード内でしか一意性が保証されない。単一事業者
 * （香川のことでん・ことでんバス）だけを扱っていた間はIDの命名規則がたまたま
 * 衝突しなかっただけで、複数事業者・複数県を組み合わせる段階1以降は
 * 小規模なコミュニティバスGTFSが"1","2","3"のような短い数字IDを使うことが多く、
 * 無名前空間化のままでは無言でIDが衝突し運賃・経路データが上書きされる。
 *
 * キーは事業者を一意に識別する文字列（config上のoperator.id）を使う。
 * gtfs-data.jp由来のフィードは feed_id が全国一意ではない（例:
 * 野々市市と内灘町が共に feed_id="communitybus"）ため、organization_id と
 * feed_id の組から作った operator.id を渡すこと。
 */
export function namespacedId(operatorId, rawId) {
  if (rawId === undefined || rawId === null || rawId === '') return rawId;
  return `${operatorId}:${rawId}`;
}
