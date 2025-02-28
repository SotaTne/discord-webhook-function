/* eslint-disable require-jsdoc */
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { v4 as uuidv4 } from "uuid";

// 更新の適応のためのコメントの追加
// 定数定義を集約
const CONSTANTS = {
  MAX_RETRY_COUNT: 3,
  TASK_LIMIT: 100,
  FETCH_TIMEOUT_MS: 10000,
  SCHEDULE_INTERVAL_MINUTES: 1,
};

// アプリが初期化されていない場合のみ初期化
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// タイプ定義
type ScheduleMode = "at" | "every";

interface ScheduleConfig {
  mode: ScheduleMode;
  target?: string; // "at"モード用のターゲット時間
  base?: string; // "every"モード用の基準時間
  per?: number; // "every"モード用の間隔（分）
}

interface ScheduleRequest {
  pathName: string;
  guildId: string;
  sendData: any;
  schedules: ScheduleConfig[];
}

interface TaskData {
  guildId: string;
  pathName: string;
  data: any;
}

// 環境変数の検証
const WEBHOOK_TARGET_URL = process.env.WEBHOOK_TARGET_URL;
if (!WEBHOOK_TARGET_URL) {
  logger.error("WEBHOOK_TARGET_URL environment variable is not set");
}

export const scheduleTask = onRequest(async (req, res) => {
  try {
    // POSTメソッド以外は拒否
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const { pathName, guildId, sendData, schedules }: ScheduleRequest =
      req.body;
    if (
      !pathName ||
      !guildId ||
      !sendData ||
      !schedules ||
      !Array.isArray(schedules)
    ) {
      res.status(400).send("Missing or invalid required parameters");
      return;
    }

    const successes: string[] = [];
    const errors: string[] = [];

    // 現在時刻
    const now = new Date();
    const nowTimestamp = admin.firestore.Timestamp.fromDate(now);

    // トランザクションを使用して、同一guildIdで現在時刻より前のスケジュールを削除
    await deleteOutdatedSchedules(guildId, nowTimestamp);

    // 新たなスケジュールを登録
    const batch = db.batch();
    for (const schedule of schedules) {
      try {
        const nextExecution = calculateNextExecution(schedule, now);
        if (!nextExecution) {
          errors.push(
            `Invalid schedule configuration: ${JSON.stringify(schedule)}`,
          );
          continue;
        }
        // 分単位に丸める（秒、ミリ秒は0）
        nextExecution.setSeconds(0, 0);
        // ドキュメントID生成: UUID
        const docId = uuidv4();
        const docRef = db.collection("schedules").doc(docId);

        batch.set(docRef, {
          pathName,
          guildId,
          sendData,
          schedule,
          nextExecution: admin.firestore.Timestamp.fromDate(nextExecution),
          status: "scheduled",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          retryCount: 0,
        });
        successes.push(
          `Scheduled ${schedule.mode} task at ${nextExecution.toISOString()}`,
        );
        logger.info(
          `Task scheduled: ${docId} at ${nextExecution.toISOString()}`,
        );
      } catch (error: any) {
        const errorMsg = `Error scheduling task: ${JSON.stringify(schedule)} - ${error.message}`;
        errors.push(errorMsg);
        logger.error(errorMsg, error);
      }
    }
    await batch.commit();
    res.status(200).json({ successes, errors });
  } catch (error: any) {
    logger.error("Unexpected error in scheduleTask:", error);
    res.status(500).send(`Internal server error: ${error.message}`);
  }
});

// 古いスケジュールを削除する関数
async function deleteOutdatedSchedules(
  guildId: string,
  nowTimestamp: admin.firestore.Timestamp,
) {
  return db.runTransaction(async (transaction) => {
    let query = db
      .collection("schedules")
      .where("guildId", "==", guildId)
      .where("nextExecution", "<", nowTimestamp)
      .limit(CONSTANTS.TASK_LIMIT);
    let snapshot = await transaction.get(query);
    let deletedCount = 0;

    while (!snapshot.empty) {
      snapshot.forEach((doc) => {
        transaction.delete(doc.ref);
        deletedCount++;
      });

      // ページネーションを使用して次のドキュメントを取得
      const lastDoc = snapshot.docs[snapshot.docs.length - 1];
      query = db
        .collection("schedules")
        .where("guildId", "==", guildId)
        .where("nextExecution", "<", nowTimestamp)
        .startAfter(lastDoc)
        .limit(CONSTANTS.TASK_LIMIT);
      snapshot = await transaction.get(query);
    }

    logger.info(
      `Deleted ${deletedCount} outdated schedules for guild ${guildId}`,
    );
  });
}

// スケジュール設定から次の実行時間を計算する関数
/**
 * Calculates the next execution time based on the provided schedule configuration and the current time.
 *
 * @param {ScheduleConfig} schedule - The schedule configuration object.
 * @param {Date} now - The current date and time.
 * @return {Date | null} - The next execution date if it can be determined, otherwise null.
 *
 * The schedule configuration can be in two modes:
 * - "at": Executes at a specific target date and time.
 * - "every": Executes at regular intervals starting from a base date and time.
 *
 * For "at" mode:
 * - If the target date is invalid or has already passed, returns null.
 *
 * For "every" mode:
 * - If the base date is invalid or the interval is not positive, returns null.
 * - Calculates the next execution time that is after the current time.
 */
function calculateNextExecution(
  schedule: ScheduleConfig,
  now: Date,
): Date | null {
  if (schedule.mode === "at" && schedule.target) {
    const nextExecution = new Date(schedule.target);
    if (isNaN(nextExecution.getTime()) || nextExecution <= now) {
      return null;
    }
    return nextExecution;
  } else if (
    schedule.mode === "every" &&
    schedule.base &&
    schedule.per &&
    schedule.per > 0
  ) {
    const baseTime = new Date(schedule.base);
    if (isNaN(baseTime.getTime())) {
      return null;
    }
    const baseMs = baseTime.getTime();
    const intervalMs = schedule.per * 60 * 1000; // per は分単位
    const nowMs = now.getTime();
    // 現在時刻を超える最も早い実行時刻を計算
    const multiplier = Math.floor((nowMs - baseMs) / intervalMs) + 1;
    const nextExecutionMs = baseMs + multiplier * intervalMs;
    return new Date(nextExecutionMs);
  }
  return null;
}

export const checkAndTriggerTasks = onSchedule(
  `every ${CONSTANTS.SCHEDULE_INTERVAL_MINUTES} minutes`,
  async (_event) => {
    try {
      const now = admin.firestore.Timestamp.now();
      const tasks = await fetchTasksToExecute(now);

      if (tasks.length === 0) {
        logger.debug("No tasks to execute at this time");
        return;
      }

      logger.info(`Found ${tasks.length} tasks to execute`);

      if (!WEBHOOK_TARGET_URL) {
        logger.error(
          "Cannot send tasks: WEBHOOK_TARGET_URL environment variable is not set",
        );
        throw new Error("WEBHOOK_TARGET_URL environment variable is not set");
      }

      try {
        await processTasks(tasks, now);
      } catch (error: any) {
        logger.error("Error processing tasks:", error);
        // 接続エラー等の場合、次回実行時に再試行
      }
    } catch (error: any) {
      logger.error("Unexpected error in checkAndTriggerTasks:", error);
    }
  },
);

// 実行すべきタスクを取得する関数
async function fetchTasksToExecute(
  now: admin.firestore.Timestamp,
): Promise<TaskData[]> {
  const tasks: TaskData[] = [];
  let query = db
    .collection("schedules")
    .where("nextExecution", "<=", now)
    .where("status", "==", "scheduled")
    .limit(CONSTANTS.TASK_LIMIT);
  let snapshot = await query.get();

  while (!snapshot.empty) {
    snapshot.forEach((doc) => {
      const data = doc.data();
      tasks.push({
        guildId: data.guildId,
        pathName: data.pathName,
        data: data.sendData,
      });
    });

    // ページネーションを使用して次のドキュメントを取得
    const lastDoc = snapshot.docs[snapshot.docs.length - 1];
    query = db
      .collection("schedules")
      .where("nextExecution", "<=", now)
      .where("status", "==", "scheduled")
      .startAfter(lastDoc)
      .limit(CONSTANTS.TASK_LIMIT);
    snapshot = await query.get();
  }

  return tasks;
}

// タスクを処理する関数
async function processTasks(tasks: TaskData[], now: admin.firestore.Timestamp) {
  try {
    const response = await fetch(WEBHOOK_TARGET_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tasks),
      signal: AbortSignal.timeout(CONSTANTS.FETCH_TIMEOUT_MS),
    });

    // タスクのドキュメント参照を一括取得
    const taskRefs = await Promise.all(
      tasks.map(async (task) => {
        const querySnapshot = await db
          .collection("schedules")
          .where("guildId", "==", task.guildId)
          .where("pathName", "==", task.pathName)
          .get();
        return querySnapshot.empty ? null : querySnapshot.docs[0].ref;
      }),
    );

    // 有効なドキュメント参照のみをフィルタリング
    const validRefs = taskRefs.filter(
      (ref): ref is admin.firestore.DocumentReference => ref !== null,
    );

    if (response.ok) {
      await handleSuccessfulTasks(validRefs);
    } else {
      await handleFailedTasks(
        validRefs,
        `HTTP ${response.status}: ${response.statusText}`,
      );
    }
  } catch (error: any) {
    logger.error("Error sending tasks:", error);
    throw error;
  }
}

// 成功したタスクを処理する関数
async function handleSuccessfulTasks(
  docRefs: admin.firestore.DocumentReference[],
) {
  const successBatch = db.batch();
  let successCount = 0;
  let failureCount = 0;
  await Promise.all(
    docRefs.map(async (docRef) => {
      const doc = await docRef.get();
      const data = doc.data();
      if (!data) return;
      if (
        data.schedule?.mode === "every" &&
        data.schedule?.base &&
        data.schedule?.per
      ) {
        const newNextExecution = calculateNextExecution(
          data.schedule,
          new Date(),
        );
        if (newNextExecution) {
          successBatch.update(docRef, {
            nextExecution: admin.firestore.Timestamp.fromDate(newNextExecution),
            lastExecution: data.nextExecution,
            retryCount: 0,
          });
          successCount++;
        } else {
          // 万が一再計算に失敗した場合は失敗としてマーク
          successBatch.update(docRef, {
            status: "failed",
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
            failureReason: "Unable to recalculate next execution",
          });
          failureCount++;
        }
      } else {
        // atモードの場合はタスク完了としてマーク
        successBatch.update(docRef, {
          status: "completed",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        successCount++;
      }
    }),
  );

  if (successCount > 0 || failureCount > 0) {
    await successBatch.commit();
    logger.info(
      `Processed ${successCount} tasks successfully, ${failureCount} tasks failed`,
    );
  }
}

// 失敗したタスクを処理する関数
async function handleFailedTasks(
  docRefs: admin.firestore.DocumentReference[],
  failureReason: string,
) {
  const retryBatch = db.batch();
  const failureBatch = db.batch();
  let retryCount = 0;
  let failureCount = 0;
  await Promise.all(
    docRefs.map(async (docRef) => {
      const doc = await docRef.get();
      const data = doc.data();
      if (!data) return;
      const currentRetry = data.retryCount || 0;
      if (currentRetry < CONSTANTS.MAX_RETRY_COUNT) {
        retryBatch.update(docRef, {
          retryCount: currentRetry + 1,
          lastRetryAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        retryCount++;
      } else {
        failureBatch.update(docRef, {
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason,
        });
        failureCount++;
      }
    }),
  );

  // 各バッチを更新があった場合のみコミット
  if (retryCount > 0) {
    await retryBatch.commit();
    logger.info(`Scheduled ${retryCount} tasks for retry`);
  }
  if (failureCount > 0) {
    await failureBatch.commit();
    logger.info(`Marked ${failureCount} tasks as failed`);
  }
}
