export const en = {
  groupsOnly: "I only work in group chats. Add me to a group and talk to me there.",
  ownerMissingLeaving: "I can only stay in groups where my owner is a member, so I'm leaving. Bye!",
  welcome:
    "Hi, I'm here. Mention me, reply to one of my messages, or react to a message with my trigger emoji and I'll jump in. I read the whole conversation, so I have the context. Everything else is behind the settings button.",
  settingsButton: "Settings",
  adminHint: "Tip: make me an admin so I can see the whole conversation and react to messages.",
  refusal: "I can't help with that one.",
  cutShort: "(cut short)",
  runFailed: "Something went wrong and I couldn't answer. Please try again.",
  sourcesLabel: "Sources",
  bakeryApprove: "Approve",
  bakeryReject: "Cancel",
  bakeryUnreachable: "Couldn't reach the bakery. Please try again.",
  bakeryUnavailableNotice: "The bakery couldn't be reached, so I answered without its data.",
  noNewerMessages: "No newer messages.",
} as const;

export type MsgKey = keyof typeof en;
