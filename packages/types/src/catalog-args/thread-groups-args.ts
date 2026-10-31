import { Schema } from 'effect';
import { AGENT_SEMANTIC_COLOR_IDS } from '../agent-color.ts';
import { ASSISTANT_THREAD_ICON_IDS, type ThreadGroupsRequest } from '../thread-groups.ts';

const Text = Schema.String.check(Schema.isNonEmpty());
const Color = Schema.NullOr(Schema.Literals(AGENT_SEMANTIC_COLOR_IDS));
const Icon = Schema.NullOr(Schema.Literals(ASSISTANT_THREAD_ICON_IDS));

/** One thread-groups request, decoded wherever it crosses a process boundary. */
export const ThreadGroupsRequestSchema: Schema.Decoder<ThreadGroupsRequest> = Schema.Union([
  Schema.Struct({ operation: Schema.Literal('list'), resourceId: Text }),
  Schema.Struct({
    group: Schema.Struct({
      color: Color,
      icon: Icon,
      id: Text,
      name: Text,
      rank: Text,
      resourceId: Text,
    }),
    operation: Schema.Literal('create'),
  }),
  Schema.Struct({ groupId: Text, operation: Schema.Literal('delete') }),
  Schema.Struct({ groupId: Text, name: Text, operation: Schema.Literal('rename') }),
  Schema.Struct({ color: Color, groupId: Text, operation: Schema.Literal('color') }),
  Schema.Struct({ groupId: Text, icon: Icon, operation: Schema.Literal('icon') }),
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ groupId: Text, rank: Text })),
    operation: Schema.Literal('ranks'),
  }),
  Schema.Struct({
    operation: Schema.Literal('placements'),
    placements: Schema.Array(
      Schema.Struct({
        flatRank: Schema.NullOr(Text),
        groupId: Schema.NullOr(Text),
        rank: Text,
        resourceId: Text,
        threadId: Text,
      })
    ),
  }),
  Schema.Struct({
    operation: Schema.Literal('pin'),
    pin: Schema.Struct({
      pinnedAt: Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
      ),
      resourceId: Text,
      threadId: Text,
    }),
  }),
  Schema.Struct({ operation: Schema.Literal('unpin'), threadId: Text }),
  Schema.Struct({ operation: Schema.Literal('clear'), threadIds: Schema.Array(Text) }),
]);

export const parseThreadGroupsRequest = Schema.decodeUnknownSync(ThreadGroupsRequestSchema, {
  onExcessProperty: 'error',
});
