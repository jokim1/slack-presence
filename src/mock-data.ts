import type { Channel, Member, Presence } from "./types";

export const MOCK_TEAM_ID = "T_DEMO";
export const MOCK_TEAM_NAME = "Acme Studio";

export const mockChannels: Channel[] = [
  { id: "C_DESIGN", name: "design", isPrivate: false },
  { id: "C_PRODUCT", name: "product", isPrivate: false },
  { id: "G_LAUNCH", name: "launch-room", isPrivate: true },
];

const people = [
  ["U_MAYA", "Maya Chen", "Product Designer", "active"],
  ["U_JONAH", "Jonah Reed", "Staff Engineer", "active"],
  ["U_AMARA", "Amara Okafor", "Product Lead", "away"],
  ["U_LEO", "Leo Martins", "Frontend Engineer", "active"],
  ["U_SOFIA", "Sofia Park", "Research", "away"],
  ["U_NOAH", "Noah Williams", "Design Engineer", "away"],
] as const;

function makeMember(
  [id, displayName, title, presence]: (typeof people)[number],
): Member {
  return { id, displayName, title, presence: presence as Presence, avatarUrl: "" };
}

export const mockMembersByChannel: Record<string, Member[]> = {
  C_DESIGN: people.map(makeMember),
  C_PRODUCT: people.slice(0, 5).map(makeMember),
  G_LAUNCH: [people[0], people[1], people[3]].map((person) =>
    makeMember(person),
  ),
};

export function mockPresence(userId: string): PresenceReplyLike {
  const secondBucket = Math.floor(Date.now() / 30_000);
  const checksum = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return {
    userId,
    presence: (checksum + secondBucket) % 4 === 0 ? "away" : "active",
  };
}

interface PresenceReplyLike {
  userId: string;
  presence: Presence;
}
