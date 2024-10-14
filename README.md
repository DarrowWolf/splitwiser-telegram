
# Splitwise Telegram Bot

This is a simple Telegram bot that integrates with the Splitwise API, allowing you to manage your Splitwise groups and expenses via Telegram commands. It also gets rid of that stupid "You have to pay for Splitwise premium to add unlimited expenses"

## Setup Instructions

### Step 1: Clone the Repository

Start by cloning this repository to your local machine:

```bash
git clone <repository_url>
cd <repository_folder>
```

### Step 2: Install Dependencies

Before running the application, you need to install the required packages. Run:

```bash
npm install
```

### Step 3: Create the `.env` File

Create a `.env` file in the root of the project directory. The contents should include the following:

```
CLIENT_ID=
CLIENT_SECRET=
REDIRECT_URI=
TELEGRAM_BOT_TOKEN=
```

You'll need to fill in these values by following the next steps.

### Step 4: Obtain Splitwise API Credentials

1. Go to [Splitwise Apps](https://secure.splitwise.com/apps) to register your app.
2. Log in to your Splitwise account if you haven’t already.
3. Click on **Register your Application**.
4. Enter the following details:
   - **Name**: Name of your application.
   - **Description**: A short description of your app.
   - **Homepage URL**: Your website or GitHub repository URL (if applicable).
5. Accept the terms and click **Register** to get your API key.

After registration, you’ll receive:
- **Consumer Key**: Use this as your `CLIENT_ID`.
- **Consumer Secret**: Use this as your `CLIENT_SECRET`.

### Step 5: Set Up the Redirect URI

1. Download and install [ngrok](https://ngrok.com/).
2. Start ngrok by running the following command:

   ```bash
   ngrok http 3000
   ```

3. Copy the HTTPS URL provided by ngrok and append `/oauth/callback` to it. This will be your `REDIRECT_URI`.
   
   Example:
   ```
   https://your-ngrok-url.ngrok.io/oauth/callback
   ```

4. Update your Splitwise application with this same `REDIRECT_URI` under the redirect URL field.

### Step 6: Get Your Telegram Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Start a conversation with BotFather and follow these steps:
   - Type `/start`.
   - Type `/newbot` and follow the prompts to create a new bot.
   - Once created, you’ll receive a **Bot Token**. Copy this token.
3. Paste the token into your `.env` file under `TELEGRAM_BOT_TOKEN`.

### Step 7: Run the Application

After setting up your environment variables and installing the necessary dependencies, run the app using:

```bash
node app.js
```

### Step 8: Using the Telegram Bot

Once your bot is up and running, you can interact with it via Telegram. Use the following commands:

- `/login` - Log in to your Splitwise account.
- `/groups` or `/group` - View your Splitwise groups.
- `/unlink` - Unlink your Splitwise account.
- `/expense` - Create a new expense. (must have default group set)
- `/setgroup` - Set a default group for your expenses.
- `/balance` - See group's balances. (must have default group set)

---
