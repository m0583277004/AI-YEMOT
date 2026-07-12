// ============================================================
// שרת שמחבר קו ימות המשיח לצ'אט AI (Claude) בשיחה קולית בעברית
// ============================================================
// איך זה עובד, בקצרה:
// 1. מתקשר מחייג לשלוחת ה-API שהגדרת בימות המשיח.
// 2. ימות המשיח שולח בקשה לשרת הזה בכל פעם שיש נתון חדש (דיבור).
// 3. אנחנו קוראים את הדיבור באמצעות מנוע זיהוי הדיבור המובנה של ימות (mode: 'stt'),
//    שולחים את הטקסט ל-Claude, ומקבלים תשובה.
// 4. ימות המשיח מקריא את התשובה למתקשר (באמצעות מנוע ההקראה המובנה שלו),
//    ומיד ממשיך להאזין למשפט הבא - כך נוצרת שיחה רציפה.
//
// חשוב: קרא את קובץ README.md לפני ההרצה - הוא מסביר איך להגדיר הכל שלב-אחר-שלב.
// ============================================================

import "dotenv/config";
import express from "express";
import { YemotRouter } from "yemot-router2";
import Anthropic from "@anthropic-ai/sdk";

// ---------- הגדרות בסיסיות ----------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const PORT = process.env.PORT || 3000;

// כמה החלפות (שאלה+תשובה) מותר לעשות בשיחה אחת, כדי למנוע שיחות אינסופיות/יקרות
const MAX_TURNS = Number(process.env.MAX_TURNS || 25);

// ההודעה הראשונה שהמתקשר שומע
const GREETING =
  "שלום! אני עוזר קולי חכם שרץ על בינה מלאכותית. אפשר לשאול אותי כל דבר. במה אוכל לעזור?";

// "אישיות" העוזר - אפשר לשנות את זה חופשי כדי להתאים לצרכים שלך
const SYSTEM_PROMPT = `את/ה עוזר קולי ידידותי שמדבר עברית בשיחת טלפון רגילה.
חשוב מאוד:
- ענה תמיד בעברית בלבד, במשפטים קצרים וברורים, כמו שמדברים בטלפון.
- אל תשתמש בסימנים מיוחדים, כוכביות, רשימות ממוספרות, או עיצוב טקסט - זה נקרא בקול על ידי מכונת הקראה.
- הימנע ממקפים, גרשיים וגרש בודד ומסימן '&' בתשובה.
- שמור על תשובות קצרות (עד 2-3 משפטים), כי זו שיחה קולית ולא צ'אט כתוב.
- אם השאלה לא ברורה, בקש הבהרה בנימוס.`;

if (!ANTHROPIC_API_KEY) {
  console.error(
    "שגיאה: חסר משתנה סביבה ANTHROPIC_API_KEY. הוסף אותו בקובץ .env או בהגדרות השרת (Render וכו')."
  );
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// זיכרון שיחה זמני - מפתח: מזהה שיחה (callId), ערך: מערך ההודעות עד כה
// שים לב: זה נשמר רק בזיכרון השרת. אם השרת מופעל מחדש (למשל אחרי שינה בשירות חינמי),
// שיחות פתוחות "ישכחו" את ההיסטוריה שלהן. לשימוש כבד יותר אפשר לשדרג לשמירה במסד נתונים.
const conversations = new Map();

function cleanText(text) {
  // מסיר תווים שימות המשיח לא מסוגל להקריא, ליתר ביטחון (מעבר ל-removeInvalidChars)
  return (text || "").replace(/[.\-'"&]/g, " ").trim();
}

// מילות סיום שיחה נפוצות - אם המתקשר אומר אותן, מסיימים את השיחה בנימוס
const HANGUP_WORDS = /^(תודה|תודה רבה|להתראות|ביי|סיום|תפסיק|די|זהו|סגור)\b/i;

// ---------- הראוטר של ימות המשיח ----------

const router = YemotRouter({
  printLog: true, // הדפסת לוג מפורט - שימושי לבדיקות. אפשר לכבות בהמשך (false)
  timeout: "90s", // כמה זמן לחכות לתגובה מהמתקשר - הוגדל כדי לתת מרווח למקרה של "התעוררות" איטית של השרת בתוכנית החינמית
});

// הפונקציה שמטפלת בשיחה - רשומה גם עבור GET וגם עבור POST (ראו למטה),
// כדי שזה יעבוד בלי קשר להגדרת api_url_post בימות המשיח.
const handleCall = async (call) => {
  const callId = call.ApiCallId || call.callId || call.values?.ApiCallId;

  if (!conversations.has(callId)) {
    conversations.set(callId, []);
  }
  const history = conversations.get(callId);

  let promptToUser = history.length === 0 ? GREETING : "שאל אותי עוד משהו.";
  let turn = 0;

  while (turn < MAX_TURNS) {
    let userText;
    try {
      userText = await call.read(
        [{ type: "text", data: promptToUser, removeInvalidChars: true }],
        "stt",
        {
          lang: "he",
        }
      );
    } catch (err) {
      // אם המתקשר כבר ניתק את השיחה, אין טעם לנסות לשלוח לו הודעה - זה רק יוצר שגיאה מיותרת בלוגים
      if (err?.name === "HangupError" || /hangup/i.test(err?.message || "")) {
        console.log(`השיחה נותקה על ידי המתקשר (callId=${callId})`);
        conversations.delete(callId);
        return;
      }
      console.error(`### שגיאת read: name=${err?.name} | message=${err?.message}`);
      console.error("שגיאה בקבלת דיבור מהמתקשר - פרטים מלאים:", err);
      return call.id_list_message([
        {
          type: "text",
          data: "מצטער, אירעה שגיאה טכנית בזיהוי הדיבור. נסה להתקשר שוב.",
          removeInvalidChars: true,
        },
      ]);
    }

    const cleanUserText = (userText || "").trim();

    // לא זוהה דיבור / שקט
    if (!cleanUserText || cleanUserText === "None") {
      return call.id_list_message([
        { type: "text", data: "לא הצלחתי לשמוע כלום. נדבר בפעם הבאה, להתראות.", removeInvalidChars: true },
      ]);
    }

    // בקשת סיום שיחה מפורשת
    if (HANGUP_WORDS.test(cleanUserText)) {
      conversations.delete(callId);
      return call.id_list_message([
        { type: "text", data: "תודה שהתקשרת, להתראות!", removeInvalidChars: true },
      ]);
    }

    history.push({ role: "user", content: cleanUserText });
    console.log(`### המתקשר אמר: "${cleanUserText}"`);

    let aiText;
    try {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: history,
      });

      aiText = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
    } catch (err) {
      console.error(`### שגיאת Claude API: name=${err?.name} | message=${err?.message}`);
      console.error("שגיאה בפנייה ל-Claude API - פרטים מלאים:", err);
      conversations.delete(callId);
      return call.id_list_message([
        {
          type: "text",
          data: "מצטער, יש כרגע תקלה טכנית בחיבור לבינה המלאכותית. נסה שוב בעוד כמה דקות.",
          removeInvalidChars: true,
        },
      ]);
    }

    console.log(`### Claude ענה: "${aiText}"`);
    aiText = cleanText(aiText) || "לא הצלחתי לנסח תשובה. נסה לשאול בצורה אחרת.";
    history.push({ role: "assistant", content: aiText });

    promptToUser = aiText;
    turn++;
  }

  // הגענו למספר השיחות המקסימלי בשיחה אחת
  conversations.delete(callId);
  return call.id_list_message([
    {
      type: "text",
      data: "הגענו למספר השאלות המרבי לשיחה אחת. אפשר להתקשר שוב בכל עת. להתראות!",
      removeInvalidChars: true,
    },
  ]);
};

// רושמים את אותה פונקציה גם ל-GET וגם ל-POST - כך זה עובד בלי קשר
// להגדרת api_url_post בימות המשיח (אפשר יהיה גם למחוק את השורה הזו מימות ולהשתמש ב-GET).
router.get("/", handleCall);
router.post("/", handleCall);

// ניקוי זיכרון כשהמתקשר מנתק את השיחה
router.events.on("call_hangup", (call) => {
  const callId = call.ApiCallId || call.callId || call.values?.ApiCallId;
  if (callId) conversations.delete(callId);
});

// ---------- הרצת שרת Express ----------

const app = express();

// חשוב: ימות המשיח שולח את הנתונים כ-POST בפורמט urlencoded (כי הגדרנו api_url_post=yes).
// בלי המידלוור הזה, Express לא קורא את גוף הבקשה (req.body), וה-yemot-router2 לא מקבל
// שום מידע על השיחה - זו הסיבה הנפוצה ביותר ל"אין מענה משרת API" למרות שהבקשה מגיעה לשרת.
// type: () => true - מכריח את הפענוח גם אם ימות לא שולח כותרת Content-Type תקנית.
app.use(express.urlencoded({ extended: true, type: () => true }));

// לוג קצר לכל בקשה שמגיעה - שימושי לבדיקות עתידיות. אפשר למחוק את זה בהמשך אם רוצים לוגים נקיים יותר.
app.use((req, res, next) => {
  console.log(`### בקשת ${req.method} התקבלה`);
  next();
});

app.use(router);

app.get("/", (req, res) => {
  // עמוד "בדיקת חיים" בדפדפן - כדי לוודא שהשרת פעיל
  res.send("שרת ימות-Claude פעיל. חבר את זה לשלוחת API בימות המשיח.");
});

app.listen(PORT, () => {
  console.log(`השרת פעיל על פורט ${PORT}`);
});
