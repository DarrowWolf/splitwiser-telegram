import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  TELEGRAM_BOT_TOKEN,
} from "./config.js";
import { Token } from "./db.js";
import chalk from "chalk";

const log = {
  info: (...msg) => console.log(chalk.blue("[INFO]"), ...msg),
  success: (...msg) => console.log(chalk.green("[SUCCESS]"), ...msg),
  error: (...msg) => console.error(chalk.red("[ERROR]"), ...msg),
  debug: (...msg) => console.log(chalk.cyan("[DEBUG]"), ...msg),
};

log.info("Starting bot with token:", TELEGRAM_BOT_TOKEN);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
  request: {
    agentOptions: {
      keepAlive: false,
      family: 4,
    },
  },
});
log.success("Bot is up and running...");

bot.on("polling_error", (error) => {
  log.error("Polling error occurred:", error);
});

bot.on("webhook_error", (error) => {
  log.error("Webhook error occurred:", error);
});

// Function to load a token for a specific chat
const loadToken = async (chatId) => {
  try {
    log.debug(`Loading token from database for chat ID: ${chatId}`);
    const token = await Token.findOne({ where: { chatId } });
    return token ? token.accessToken : null;
  } catch (error) {
    log.error("Error loading token from database:", error);
    return null;
  }
};

// Function to save a token for a specific chat
const saveToken = async (chatId, accessToken) => {
  try {
    log.debug(`Saving token to database for chat ID: ${chatId}`);
    log.debug(`Type of chatId: ${typeof chatId}`);
    if (typeof chatId !== "string" && typeof chatId !== "number") {
      throw new Error(`Invalid chatId type: ${typeof chatId}`);
    }
    const existingToken = await Token.findOne({ where: { chatId } });
    if (existingToken) {
      existingToken.accessToken = accessToken;
      await existingToken.save();
    } else {
      await Token.create({ chatId, accessToken });
    }
    log.success(`Token saved successfully for chat ID: ${chatId}`);
  } catch (error) {
    log.error("Error saving token to database:", error);
  }
};

const userSessions = {};

const BUTTON_TIMEOUT = 60 * 1000;

const cleanUpSession = async (chatId) => {
  const session = userSessions[chatId];
  if (session) {
    log.debug(`Cleaning up session for chat ID: ${chatId}`);

    // Clear any timeouts
    if (session.timeout) {
      clearTimeout(session.timeout);
      delete session.timeout;
    }

    // Delete stored messages
    const messageIds = session.messageIds || [];
    for (const messageId of messageIds) {
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        log.error(`Failed to delete message ${messageId}:`, err);
      }
    }

    // Delete the session
    delete userSessions[chatId];
    log.debug(`Session for chat ID ${chatId} has been deleted.`);
  }
};

const setButtonTimeout = (chatId, sentMessage) => {
  const session = userSessions[chatId];

  // Clear existing timeout if any
  if (session && session.timeout) {
    clearTimeout(session.timeout);
    delete session.timeout;
    log.debug(`Existing timeout cleared for chat ID: ${chatId}`);
  }

  const timeout = setTimeout(async () => {
    log.debug(`Button timeout expired for chat ID: ${chatId}`);

    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: sentMessage.message_id,
        }
      );

      // Delete the message after editing
      await bot.deleteMessage(chatId, sentMessage.message_id);
    } catch (err) {
      log.error(
        `Failed to edit or delete message ${sentMessage.message_id}:`,
        err
      );
    }

    // Send session expired message
    const expiredMessage = await bot.sendMessage(
      chatId,
      "The session has expired. Please try again if needed."
    );

    // Store the expired message ID
    if (!session.messageIds) session.messageIds = [];
    session.messageIds.push(expiredMessage.message_id);

    // Clean up the session
    delete userSessions[chatId];
    log.debug(`Session for chat ID ${chatId} has been deleted due to timeout.`);
  }, BUTTON_TIMEOUT);

  log.debug(`Setting button timeout for chat ID: ${chatId}`);
  if (!session) userSessions[chatId] = {};
  userSessions[chatId].timeout = timeout;

  // Store the message ID
  if (!session.messageIds) session.messageIds = [];
  session.messageIds.push(sentMessage.message_id);
};

bot.onText(/\/login/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  log.info(
    `Received /login command from chat ID: ${chatId}, user ID: ${userId}`
  );

  // Clean up any existing session
  await cleanUpSession(chatId);

  // Check if the chat already has a linked account
  const token = await Token.findOne({ where: { chatId } });
  if (token && token.accessToken) {
    log.debug(`Account already linked for chat ID: ${chatId}`);
    bot.sendMessage(
      chatId,
      "An account is already linked to this group. Please use /unlink to remove the current account before logging in with a new one."
    );
    return;
  }

  const authUrl = `https://secure.splitwise.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&state=${chatId}`;

  log.debug(`Sending login link to chat ID ${chatId}: ${authUrl}`);

  bot
    .sendMessage(chatId, `Click to log in to Splitwise: ${authUrl}`)
    .then((sentMessage) => {
      userSessions[chatId] = {
        loginMessageId: sentMessage.message_id,
      };
    });
});

bot.onText(/\/unlink/, async (msg) => {
  const chatId = msg.chat.id;
  log.info(`Received /unlink command from chat ID: ${chatId}`);

  // Clean up any existing session
  await cleanUpSession(chatId);

  // Check if there's a linked account
  const token = await Token.findOne({ where: { chatId } });
  if (!token || !token.accessToken) {
    log.debug(`No account linked for chat ID: ${chatId}`);
    bot.sendMessage(chatId, "No account is currently linked to this group.");
    return;
  }

  // Delete the token record to unlink the account
  try {
    await Token.destroy({ where: { chatId } }); // Delete the token entry
    log.success(`Account unlinked successfully for chat ID: ${chatId}`);
    bot.sendMessage(
      chatId,
      "The account has been unlinked successfully. You can now log in with a new account using /login."
    );
  } catch (error) {
    log.error(`Error unlinking account for chat ID: ${chatId}`, error);
    bot.sendMessage(chatId, "Failed to unlink the account. Please try again.");
  }
});

bot.onText(/\/group/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  log.info(
    `Received /group command from chat ID: ${chatId}, user ID: ${userId}`
  );

  // Clean up any existing session
  await cleanUpSession(chatId);

  // Retrieve token from the database
  const accessToken = await loadToken(chatId);
  if (!accessToken) {
    log.debug(`No access token found for chat ID: ${chatId}`);
    bot.sendMessage(chatId, "You are not logged in. Please use /login first.");
    return;
  }

  try {
    log.debug(`Fetching groups for chat ID: ${chatId}`);
    const response = await fetch(
      "https://secure.splitwise.com/api/v3.0/get_groups",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const data = await response.json();
    const groups = data.groups;
    if (!groups || groups.length === 0) {
      log.debug(`No groups found for chat ID: ${chatId}`);
      bot.sendMessage(chatId, "You are not part of any groups.");
      return;
    }

    log.debug(
      `Storing user session for chat ID: ${chatId}, user ID: ${userId}`
    );
    userSessions[chatId] = { userId, messageIds: [] };

    const groupButtons = groups.map((group) => [
      {
        text: group.name,
        callback_data: `group_${group.id}`,
      },
    ]);
    const sentMessage = await bot.sendMessage(chatId, "Here are your groups:", {
      reply_markup: { inline_keyboard: groupButtons },
    });

    // Store the message ID
    userSessions[chatId].messageIds.push(sentMessage.message_id);

    setButtonTimeout(chatId, sentMessage);
  } catch (err) {
    log.error(`Error fetching groups for chat ID ${chatId}:`, err);
    bot.sendMessage(chatId, "Failed to fetch groups. Please try again.");
  }
});

bot.onText(/\/setgroup/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  log.info(
    `Received /setgroup command from chat ID: ${chatId}, user ID: ${userId}`
  );

  // Clean up any existing session
  await cleanUpSession(chatId);

  // Retrieve the access token from the database
  const accessToken = await loadToken(chatId);
  if (!accessToken) {
    log.debug(`No access token found for chat ID: ${chatId}`);
    bot.sendMessage(chatId, "You are not logged in. Please use /login first.");
    return;
  }

  try {
    log.debug(`Fetching groups for chat ID: ${chatId}`);
    const response = await fetch(
      "https://secure.splitwise.com/api/v3.0/get_groups",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const data = await response.json();
    const groups = data.groups;

    if (!groups || groups.length === 0) {
      log.debug(`No groups found for chat ID: ${chatId}`);
      bot.sendMessage(chatId, "You are not part of any groups.");
      return;
    }

    // Store the user session including the userId and groups
    userSessions[chatId] = { userId, groups, messageIds: [] };

    const groupButtons = groups.map((group) => [
      {
        text: group.name,
        callback_data: `setgroup_${group.id}`,
      },
    ]);
    const sentMessage = await bot.sendMessage(
      chatId,
      "Select a group to set as default:",
      {
        reply_markup: { inline_keyboard: groupButtons },
      }
    );

    // Store the message ID
    userSessions[chatId].messageIds.push(sentMessage.message_id);
  } catch (err) {
    log.error(`Error fetching groups for chat ID ${chatId}:`, err);
    bot.sendMessage(chatId, "Failed to fetch groups. Please try again.");
  }
});

bot.onText(/\/expense/, async (msg) => {
	const chatId = msg.chat.id;
	const userId = msg.from.id;
	log.info(
		`Received /expense command from chat ID: ${chatId}, user ID: ${userId}`
	);

	// Clean up any existing session
	await cleanUpSession(chatId);

	// Retrieve the token and default group from the database
	const token = await Token.findOne({ where: { chatId } });
	if (!token || !token.accessToken) {
		log.debug(`No access token found for chat ID: ${chatId}`);
		bot.sendMessage(chatId, "You are not logged in. Please use /login first.");
		return;
	}

	if (!token.defaultGroupId) {
		log.debug(`No default group set for chat ID: ${chatId}`);
		bot.sendMessage(
			chatId,
			"No default group is set. Please use /setgroup first."
		);
		return;
	}

	const accessToken = token.accessToken;
	const groupId = token.defaultGroupId;

	// Prompt for expense description
	userSessions[chatId] = {
		step: "awaiting_description",
		groupId,
		userId,
		messageIds: [],
	};

	bot
		.sendMessage(chatId, "Please enter a description for the expense:")
		.then((sentMessage) => {
			userSessions[chatId].messageIds.push(sentMessage.message_id);
		});
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  log.info(
    `Received /balance command from chat ID: ${chatId}, user ID: ${userId}`
  );

  // Clean up any existing session
  await cleanUpSession(chatId);

  // Retrieve the access token from the database
  const accessToken = await loadToken(chatId);
  if (!accessToken) {
    log.debug(`No access token found for chat ID: ${chatId}`);
    bot.sendMessage(chatId, "You are not logged in. Please use /login first.");
    return;
  }

  try {
    const token = await Token.findOne({ where: { chatId } });
    if (!token || !token.defaultGroupId) {
      log.debug(`No default group set for chat ID: ${chatId}`);
      bot.sendMessage(
        chatId,
        "No default group is set. Please use /setgroup first."
      );
      return;
    }

    const groupId = token.defaultGroupId;

    log.debug(`Fetching group details for group ID: ${groupId}`);
    const groupResponse = await fetch(
      `https://secure.splitwise.com/api/v3.0/get_group/${groupId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const groupData = await groupResponse.json();
    const group = groupData.group;

    let groupInfo = `*Group Name*: ${group.name}\n`;
    groupInfo += `*Group Members and Balances*:\n`;

    group.members.forEach((member) => {
      const firstName = member.first_name || '';
      const lastName = member.last_name || '';

      let balanceAmount = '0.00';
      let balanceCurrency = '';
      if (member.balance && member.balance.length > 0 && member.balance[0]) {
        balanceAmount = member.balance[0].amount || '0.00';
        balanceCurrency = member.balance[0].currency_code || '';
      }

      let memberInfo = `- ${firstName} ${lastName}`;
      if (balanceCurrency) {
        memberInfo += ` (Balance: ${balanceAmount} ${balanceCurrency})`;
      } else {
        memberInfo += ` (Balance: ${balanceAmount})`;
      }
      groupInfo += `${memberInfo}\n`;
    });

    bot.sendMessage(chatId, groupInfo, { parse_mode: "Markdown" });

  } catch (err) {
    log.error(
      `Error fetching group details for chat ID ${chatId}:`,
      err
    );
    bot.sendMessage(
      chatId,
      "Failed to fetch group details. Please try again."
    );
  }
});

bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const fromId = callbackQuery.from.id;
  const data = callbackQuery.data;

  log.debug(
    `Callback query received from chat ID: ${chatId}, user ID: ${fromId}, data: ${data}`
  );

  const session = userSessions[chatId];

  if (session && session.timeout) {
    log.debug(`Clearing button timeout for chat ID: ${chatId}`);
    clearTimeout(session.timeout);
    delete session.timeout;
  }

  if (session && session.userId !== fromId) {
    log.error(
      `User ID ${fromId} tried to interact with button meant for user ID ${session.userId}`
    );
    bot.answerCallbackQuery(callbackQuery.id, {
      text: "You can't interact with this button.",
      show_alert: true,
    });
    return;
  }

  if (data.startsWith("group_")) {
    const groupId = data.split("_")[1];
    const accessToken = await loadToken(chatId);
    if (!accessToken) {
      log.debug(`No access token found for chat ID: ${chatId}`);
      bot.sendMessage(
        chatId,
        "You are not logged in. Please use /login first."
      );
      return;
    }

    try {
      log.debug(`Fetching group details for group ID: ${groupId}`);
      const groupResponse = await fetch(
        `https://secure.splitwise.com/api/v3.0/get_group/${groupId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const groupData = await groupResponse.json();
      const group = groupData.group;

      log.debug(`Editing message to clear buttons for chat ID: ${chatId}`);
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
        }
      );

      // Store the message ID
      if (!session.messageIds) session.messageIds = [];
      session.messageIds.push(callbackQuery.message.message_id);

      let groupInfo = `*Group Name*: ${group.name}\n`;
      groupInfo += `*Group Members*:\n`;

      group.members.forEach((member) => {
        // Handle undefined or null first_name and last_name
        const firstName = member.first_name || '';
        const lastName = member.last_name || '';

        // Handle undefined balances
        let balanceAmount = '0.00';
        let balanceCurrency = '';
        if (member.balance && member.balance.length > 0 && member.balance[0]) {
          balanceAmount = member.balance[0].amount || '0.00';
          balanceCurrency = member.balance[0].currency_code || '';
        }

        // Construct the member info line
        let memberInfo = `- ${firstName} ${lastName}`;
        if (balanceCurrency) {
          memberInfo += ` (Balance: ${balanceAmount} ${balanceCurrency})`;
        } else {
          memberInfo += ` (Balance: ${balanceAmount})`;
        }
        groupInfo += `${memberInfo}\n`;
      });

      const groupMessage = await bot.sendMessage(chatId, groupInfo, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Create expense in group",
                callback_data: `createExpense_${groupId}`,
              },
            ],
          ],
        },
      });

      // Store the message ID
      session.messageIds.push(groupMessage.message_id);

      setButtonTimeout(chatId, groupMessage);
    } catch (err) {
      log.error(
        `Error fetching group details for chat ID ${chatId}, group ID ${groupId}:`,
        err
      );
      bot.sendMessage(
        chatId,
        "Failed to fetch group details. Please try again."
      );
    }
  } else if (data.startsWith("createExpense_")) {
    const groupId = data.split("_")[1];

    log.debug(
      `Initiating expense creation for group ID: ${groupId}, chat ID: ${chatId}`
    );
    userSessions[chatId] = {
      step: "awaiting_description",
      groupId,
      userId: fromId,
      messageIds: [],
    };

    bot
      .sendMessage(chatId, "Please enter a description for the expense:")
      .then((sentMessage) => {
        userSessions[chatId].messageIds.push(sentMessage.message_id);
      });
  } else if (data.startsWith("setgroup_")) {
    const groupId = data.split("_")[1];

    // Retrieve the group name from the session
    const session = userSessions[chatId];
    const selectedGroup = session.groups.find(
      (group) => group.id.toString() === groupId
    );

    if (!selectedGroup) {
      log.error(`Group with ID ${groupId} not found for chat ID: ${chatId}`);
      bot.sendMessage(chatId, "An error occurred. Please try again.");
      return;
    }

    const groupName = selectedGroup.name; // Get the selected group's name

    log.debug(
      `Setting default group for chat ID: ${chatId} to group ID: ${groupId} (${groupName})`
    );

    try {
      const token = await Token.findOne({ where: { chatId } });
      if (token) {
        token.defaultGroupId = groupId;
        await token.save();
        log.success(`Default group set successfully for chat ID: ${chatId}`);
        bot.sendMessage(chatId, `Default group set to "${groupName}".`); // Display the group name

        // Delete the stored messages
        const messageIds = session.messageIds || [];
        for (const messageId of messageIds) {
          try {
            await bot.deleteMessage(chatId, messageId);
          } catch (err) {
            log.error(`Failed to delete message ${messageId}:`, err);
          }
        }

        // Clean up the session
        delete userSessions[chatId];
        log.debug(`Session for chat ID ${chatId} has been deleted.`);
      } else {
        log.error(`No token found for chat ID: ${chatId}`);
        bot.sendMessage(
          chatId,
          "You are not logged in. Please use /login first."
        );
      }
    } catch (error) {
      log.error(`Error setting default group for chat ID: ${chatId}`, error);
      bot.sendMessage(chatId, "Failed to set default group. Please try again.");
    }
  } else if (data === "splitEquallyYes") {
    const userSession = userSessions[chatId];
    const { groupId, description, amount, currencyCode } = userSession;
    const accessToken = await loadToken(chatId);

    try {
      log.debug(
        `Creating expense for group ID: ${groupId}, description: ${description}, amount: ${amount} ${currencyCode}`
      );
      const createExpenseResponse = await fetch(
        "https://secure.splitwise.com/api/v3.0/create_expense",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            cost: amount.toFixed(2),
            description,
            currency_code: currencyCode,
            category_id: 15,
            group_id: groupId,
            split_equally: true,
          }),
        }
      );

      const expenseData = await createExpenseResponse.json();

      if (
        expenseData.errors &&
        Array.isArray(expenseData.errors.base) &&
        expenseData.errors.base.length > 0
      ) {
        const errorMessage = expenseData.errors.base.join(", ");
        log.error(`Error creating expense: ${errorMessage}`);
        bot.sendMessage(chatId, `Failed to create expense: ${errorMessage}`);
      } else if (expenseData.expenses && expenseData.expenses.length > 0) {
        log.success(`Expense created successfully for chat ID: ${chatId}`);
        bot.sendMessage(
          chatId,
          `Expense created successfully for ${amount.toFixed(2)} ${currencyCode}`
        );
      } else {
        log.error("Unknown error occurred during expense creation.");
        bot.sendMessage(chatId, "Failed to create expense. Please try again.");
      }
    } catch (err) {
      log.error(`Error creating expense for group ID ${groupId}:`, err);
      bot.sendMessage(chatId, "Failed to create expense. Please try again.");
    } finally {
      // Delete the stored messages
      const messageIds = userSession.messageIds || [];
      for (const messageId of messageIds) {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch (err) {
          log.error(`Failed to delete message ${messageId}:`, err);
        }
      }

      // Clean up the session
      delete userSessions[chatId];
      log.debug(`Session for chat ID ${chatId} has been deleted.`);
    }
  } else if (data === "splitEquallyNo") {
    const userSession = userSessions[chatId];
    const { groupId } = userSession;
    const accessToken = await loadToken(chatId);

    try {
      log.debug(`Fetching members for group ID: ${groupId}`);
      const groupResponse = await fetch(
        `https://secure.splitwise.com/api/v3.0/get_group/${groupId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const groupData = await groupResponse.json();
      const members = groupData.group.members;

      log.debug(`Fetched ${members.length} members for group ID: ${groupId}`);
      userSessions[chatId].members = members;
      userSessions[chatId].selectedMembers = [];

      const memberButtons = members.map((member, idx) => [
        {
          text: `${member.first_name} ${member.last_name}`,
          callback_data: `toggle_member_${idx}`,
        },
      ]);

      memberButtons.push([
        { text: "Submit", callback_data: "submit_selected_members" },
      ]);

      bot
        .sendMessage(chatId, "Select members to split the expense with:", {
          reply_markup: { inline_keyboard: memberButtons },
        })
        .then((sentMessage) => {
          userSessions[chatId].messageIds.push(sentMessage.message_id);
        });
    } catch (err) {
      log.error(`Error fetching members for group ID ${groupId}:`, err);
      bot.sendMessage(
        chatId,
        "Failed to fetch group members. Please try again."
      );
    }
  } else if (data.startsWith("toggle_member_")) {
    const userSession = userSessions[chatId];

    // Check if userSession is defined
    if (!userSession) {
      log.error(`userSession is undefined for chat ID: ${chatId}`);
      bot.sendMessage(chatId, "An error occurred. Please try again.");
      return;
    }

    const memberIdx = parseInt(data.split("_")[2], 10);
    const members = userSession.members;

    if (!members[memberIdx]) return;

    const selectedMembers = userSession.selectedMembers;
    const memberId = members[memberIdx].id;

    const selectedIndex = selectedMembers.indexOf(memberId);
    if (selectedIndex > -1) {
      selectedMembers.splice(selectedIndex, 1);
    } else {
      selectedMembers.push(memberId);
    }

    const memberButtons = members.map((member, idx) => [
      {
        text: `${member.first_name} ${member.last_name} ${
          selectedMembers.includes(member.id) ? "✅" : ""
        }`,
        callback_data: `toggle_member_${idx}`,
      },
    ]);

    memberButtons.push([
      { text: "Submit", callback_data: "submit_selected_members" },
    ]);

    bot.editMessageReplyMarkup(
      { inline_keyboard: memberButtons },
      {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
      }
    );
  } else if (data === "submit_selected_members") {
    const userSession = userSessions[chatId];

    // Check if userSession is defined
    if (!userSession) {
      log.error(`userSession is undefined for chat ID: ${chatId}`);
      bot.sendMessage(chatId, "An error occurred. Please try again.");
      return;
    }

    const {
      groupId,
      description,
      amount,
      currencyCode,
      selectedMembers,
      members,
    } = userSession;
    const accessToken = await loadToken(chatId);

    // Check if selectedMembers is defined and is an array
    if (!selectedMembers || !Array.isArray(selectedMembers)) {
      log.error(
        `selectedMembers is not defined or not an array for chat ID: ${chatId}`
      );
      bot.sendMessage(
        chatId,
        "An error occurred while selecting members. Please try again."
      );
      return;
    }

    // Check if there are any selected members
    if (selectedMembers.length === 0) {
      log.error(`No members selected for expense in chat ID: ${chatId}`);
      bot.sendMessage(
        chatId,
        "No members selected. Please select at least one member."
      );
      return;
    }

    try {
      log.debug(
        `Creating expense for selected members in group ID: ${groupId} for chat ID: ${chatId}`
      );

      const usersPayload = {};
      selectedMembers.forEach((memberId, index) => {
        const member = members.find((m) => m.id === memberId);
        if (member) {
          log.debug(
            `Member selected: ${member.first_name} ${member.last_name}, Member ID: ${memberId}`
          );
          usersPayload[`users__${index}__user_id`] = memberId;
          usersPayload[`users__${index}__paid_share`] = (
            amount / selectedMembers.length
          ).toFixed(2);
          usersPayload[`users__${index}__owed_share`] = (
            amount / selectedMembers.length
          ).toFixed(2);
        } else {
          log.error(`Member with ID ${memberId} not found in the members list`);
        }
      });

      // Creating the payload for the API request
      const payload = {
        cost: amount.toFixed(2),
        description,
        currency_code: currencyCode,
        category_id: 15,
        group_id: groupId,
        ...usersPayload,
      };

      log.debug(`Payload for expense creation: ${JSON.stringify(payload)}`);

      const createExpenseResponse = await fetch(
        "https://secure.splitwise.com/api/v3.0/create_expense",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const expenseData = await createExpenseResponse.json();

      // Updated error handling
      if (
        expenseData.errors &&
        Array.isArray(expenseData.errors.base) &&
        expenseData.errors.base.length > 0
      ) {
        const errorMessage = expenseData.errors.base.join(", ");
        log.error(`Error creating expense: ${errorMessage}`);
        bot.sendMessage(chatId, `Failed to create expense: ${errorMessage}`);
      } else if (
        expenseData.expenses &&
        Array.isArray(expenseData.expenses) &&
        expenseData.expenses.length > 0
      ) {
        log.success(`Expense created successfully for chat ID: ${chatId}`);
        bot.sendMessage(
          chatId,
          `Expense created successfully for ${amount.toFixed(2)} ${currencyCode}`
        );
      } else {
        log.error("Unknown error occurred during expense creation.");
        log.error(`API Response: ${JSON.stringify(expenseData)}`);
        bot.sendMessage(chatId, "Failed to create expense. Please try again.");
      }
    } catch (err) {
      log.error(`Error creating expense for group ID ${groupId}:`, err);
      bot.sendMessage(chatId, "Failed to create expense. Please try again.");
    } finally {
      // Delete the stored messages
      const messageIds = userSession.messageIds || [];
      for (const messageId of messageIds) {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch (err) {
          log.error(`Failed to delete message ${messageId}:`, err);
        }
      }

      // Clean up the session
      delete userSessions[chatId];
      log.debug(`Session for chat ID ${chatId} has been deleted.`);
    }
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userSession = userSessions[chatId];

  if (userSession && userSession.userId === msg.from.id) {
    log.debug(
      `Processing message for chat ID: ${chatId}, step: ${userSession.step}`
    );

    // Store the user's message ID (optional, if you want to delete user messages)
    if (!userSession.messageIds) userSession.messageIds = [];
    userSession.messageIds.push(msg.message_id);

    if (userSession.step === "awaiting_description") {
      const description = msg.text.trim();
      if (description === "") {
        log.error(`Invalid description received for chat ID: ${chatId}`);
        bot.sendMessage(
          chatId,
          "Invalid description. Please enter a valid description."
        );
        return;
      }

      log.debug(`Received description: ${description} for chat ID: ${chatId}`);
      userSession.description = description;
      userSession.step = "awaiting_amount";
      bot
        .sendMessage(
          chatId,
          "Please enter the amount for the expense (e.g., 10 USD or 10, default is SGD):"
        )
        .then((sentMessage) => {
          userSession.messageIds.push(sentMessage.message_id);
        });
    } else if (userSession.step === "awaiting_amount") {
      const input = msg.text.trim();
      const amountMatch = input.match(/^(\d+(\.\d{1,2})?)\s*([A-Z]{3})?$/);

      if (!amountMatch) {
        log.error(`Invalid amount received for chat ID: ${chatId}`);
        bot.sendMessage(
          chatId,
          "Invalid amount. Please enter a valid positive number with an optional currency code (e.g., 100 USD or 100)."
        );
        return;
      }

      const amount = parseFloat(amountMatch[1]);
      const currencyCode = amountMatch[3] || "SGD";

      if (isNaN(amount) || amount <= 0) {
        log.error(`Non-positive amount received for chat ID: ${chatId}`);
        bot.sendMessage(
          chatId,
          "Invalid amount. Please enter a valid positive number."
        );
        return;
      }

      log.debug(
        `Received amount: ${amount} ${currencyCode} for chat ID: ${chatId}`
      );
      userSession.amount = amount;
      userSession.currencyCode = currencyCode;
      userSession.step = "splitEqually";

      bot
        .sendMessage(chatId, "Split equally?", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Yes", callback_data: `splitEquallyYes` }],
              [{ text: "No", callback_data: `splitEquallyNo` }],
            ],
          },
        })
        .then((sentMessage) => {
          userSession.messageIds.push(sentMessage.message_id);
        });
    }
  }
});

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  const chatId = req.query.state.toString(); // Ensure chatId is treated as a string

  log.debug(`OAuth callback initiated for chat ID: ${chatId}`);
  log.debug(`Received authorization code: ${code}`);

  // Check if the account is already linked
  const existingToken = await Token.findOne({ where: { chatId } });
  if (existingToken && existingToken.accessToken) {
    log.error(`An account is already linked to chat ID: ${chatId}`);
    res
      .status(400)
      .send(
        "An account is already linked to this group. Please unlink the current account before logging in with another one."
      );
    return;
  }

  const tokenUrl = "https://secure.splitwise.com/oauth/token";

  const params = new URLSearchParams();
  params.append("grant_type", "authorization_code");
  params.append("client_id", CLIENT_ID);
  params.append("client_secret", CLIENT_SECRET);
  params.append("code", code);
  params.append("redirect_uri", REDIRECT_URI);

  try {
    log.debug(`Exchanging code for access token at ${tokenUrl}`);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    log.debug(`Response status from token exchange: ${response.status}`);
    if (!response.ok) {
      const errorText = await response.text();
      log.error(`Failed to exchange code: ${response.statusText}`);
      log.error(`Response body: ${errorText}`);
      throw new Error(`Failed to exchange code: ${response.statusText}`);
    }

    const data = await response.json();
    const accessToken = data.access_token;

    log.debug(`Access token obtained: ${accessToken}`);
    log.debug(`Saving access token for chat ID: ${chatId}`);

    await saveToken(chatId, accessToken); // Ensure chatId is saved consistently as a string

    // Delete the previous login message, if it exists
    const session = userSessions[chatId];
    if (session && session.loginMessageId) {
      log.debug(`Deleting login message for chat ID: ${chatId}`);
      try {
        await bot.deleteMessage(chatId, session.loginMessageId);
      } catch (err) {
        log.error(`Failed to delete login message for chat ID: ${chatId}`, err);
      }
    }

    // Send success message to Telegram
    bot.sendMessage(chatId, "You have successfully logged in to Splitwise!");

    res.send("Login successful! You can close this window.");
  } catch (err) {
    log.error(`Error during OAuth callback for chat ID ${chatId}:`, err);
    res.status(500).send("Error during OAuth process");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log.info(`Server running on port ${PORT}`);
});
