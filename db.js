import { Sequelize, DataTypes } from "sequelize";

// Create a new Sequelize instance (using SQLite)
const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: "./database.sqlite",
});

// Define a Token model
const Token = sequelize.define("Token", {
  chatId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  accessToken: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  defaultGroupId: {
    type: DataTypes.STRING,
    allowNull: true,
  },
});

await sequelize.sync();

export { sequelize, Token };
