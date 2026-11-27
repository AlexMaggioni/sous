// A room's panel on a run's page: every message its members sent, round by round, and how the room
// ended, then what the room is. The run saves the room after each turn, so a room that still talks
// shows its rounds so far. A member's name selects its lane, whose panel shows its turns.
import type { Room, RoomMessage, RunPage } from "../../api/contract.ts";
import { lineCount, plural } from "../../format.ts";
import { kidsOf, type Box, type Leaf, type Part } from "../../graph/tree.ts";
import { PanelPart, Pairs, type About } from "../../plan/step-about.tsx";
import { PanelColumns } from "../../plan/step-panel.tsx";
import { CodeFrame, CodeLines } from "../../ui/code-block.tsx";
import { Fold } from "../../ui/fold.tsx";
import { Markdown } from "../../ui/markdown.tsx";
import { STATUS_LABEL, StatusIcon } from "../../ui/status-icon.tsx";

const LINK = "rounded-sm underline decoration-1 underline-offset-2 hover:text-fg";

const ENDED: Record<NonNullable<Room["ended"]>, string> = {
  decided: "The decider decided",
  agreed: "Every member agreed",
  quiet: "Nobody had more to say",
  limit: "It ran its most rounds",
};

/** The run's record of the room a box shows. */
function roomOf(run: RunPage, box: Box): Room | undefined {
  const tag = box.room;
  return tag && run.rooms?.find((room) => room.scope === tag.scope && room.name === tag.name && room.call === tag.call);
}

function leavesOf(part: Part, out: Leaf[] = []): Leaf[] {
  if (part.t === "leaf") out.push(part);
  for (const kid of kidsOf(part)) leavesOf(kid, out);
  return out;
}

type Lanes = { keys: Map<string, string>; onSelect: (key: string) => void };

function Member({ label, lanes }: { label: string; lanes: Lanes }) {
  const key = lanes.keys.get(label);
  if (!key) return <span>{label}</span>;
  return (
    <button type="button" onClick={() => lanes.onSelect(key)} className={LINK}>
      {label}
    </button>
  );
}

/** One message: who sent it to whom, then its text. */
function Message({ message, lanes }: { message: RoomMessage; lanes: Lanes }) {
  return (
    <li className="flex flex-col gap-1">
      <p className="text-xs text-muted">
        <Member label={message.from} lanes={lanes} /> to {message.to === "all" ? "everyone" : <Member label={message.to} lanes={lanes} />}
      </p>
      <div className="max-w-[70ch] text-pretty">
        <Markdown>{message.text}</Markdown>
      </div>
    </li>
  );
}

/** The messages, a part per round. Round 0 is the opening the workflow gave. */
function Transcript({ room, lanes }: { room: Room; lanes: Lanes }) {
  const rounds = new Map<number, RoomMessage[]>();
  for (const message of room.transcript) rounds.set(message.round, [...(rounds.get(message.round) ?? []), message]);
  if (!rounds.size) return <p className="text-muted">No message yet.</p>;
  return (
    <>
      {[...rounds].map(([round, messages]) => (
        <PanelPart key={round} title={round === 0 ? "Opening" : `Round ${round}`} meta={plural(messages.length, "message")}>
          <ol className="flex flex-col gap-4">
            {messages.map((message, i) => (
              <Message key={i} message={message} lanes={lanes} />
            ))}
          </ol>
        </PanelPart>
      ))}
    </>
  );
}

export type RoomCallProps = {
  run: RunPage;
  box: Box;
  onSelect: (key: string) => void;
  /** What the room is, which shows after what it said, and its settings, which show beside. */
  about: About;
};

/** The run's side of a room's panel. */
export function RoomCall({ run, box, onSelect, about }: RoomCallProps) {
  const room = roomOf(run, box);
  const lanes: Lanes = { keys: new Map(leavesOf(box).map((leaf) => [leaf.label, leaf.key])), onSelect };
  const status = box.status;
  const decision = room?.decision === undefined ? undefined : JSON.stringify(room.decision, null, 2);
  const facts = (
    <Pairs
      pairs={[
        [
          "Status",
          status && (
            <span className="inline-flex items-center gap-1.5">
              <StatusIcon status={status} label={false} />
              {STATUS_LABEL[status]}
            </span>
          ),
        ],
        ["Rounds", room ? String(room.rounds) : undefined],
        ["Ended", room?.ended ? ENDED[room.ended] : undefined],
        ["Duration", box.duration],
      ]}
    />
  );
  const did = room && (
    <>
      <Transcript room={room} lanes={lanes} />
      {decision && (
        <PanelPart title="Decision">
          <CodeFrame meta={plural(lineCount(decision), "line")} copy={decision} copyLabel="Copy the decision">
            <CodeLines code={decision} lang="json" wrap label={`Decision of ${box.title}`} />
          </CodeFrame>
        </PanelPart>
      )}
      <div className="mt-5">
        <Fold title={<span className="text-xs font-medium text-muted">Goal as given</span>}>
          <div className="max-w-[70ch] text-pretty">
            <Markdown>{room.goal}</Markdown>
          </div>
        </Fold>
      </div>
    </>
  );
  const lead = !room && (
    <p className="text-muted">
      {box.room ? "sous has no record of what this room said." : status === "skipped" ? "It didn't run. The run ended first, or its branch didn't run." : "It hasn't run yet."}
    </p>
  );
  return <PanelColumns lead={lead} facts={facts} did={did} is={about.main} side={about.side} />;
}
