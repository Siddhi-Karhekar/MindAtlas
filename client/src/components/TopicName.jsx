import { topicParts } from "../lib/notes.js";

// Shows a topic as "Subtopic" with its document underneath ("in Unit 3"), so a
// long "Document › Subtopic" label reads cleanly in cards and lists. Plain
// notes render as just their title.
export default function TopicName({ topic, className = "", parentClassName = "", as: Tag = "span" }) {
  const { parent, name } = topicParts(topic);
  return (
    <Tag className={`flex flex-col min-w-0 ${className}`}>
      <span className="truncate">{name}</span>
      {parent && (
        <span className={`font-label-sm text-label-sm text-on-surface-variant font-normal truncate ${parentClassName}`}>
          in {parent}
        </span>
      )}
    </Tag>
  );
}
