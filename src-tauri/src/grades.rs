//! Classes and grades: the storage half.
//!
//! Everything here remembers what was pasted or typed. What it adds up to — the weighted
//! grade, the letter, the GPA, the average still needed — is arithmetic in
//! `src/services/grades.ts`, where it is pure and tested.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Course {
    #[serde(default)]
    pub id: i64,
    /// The same string `tasks.course_code` carries.
    pub code: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default = "default_credits")]
    pub credits: f64,
    #[serde(default)]
    pub target_percent: Option<f64>,
    #[serde(default)]
    pub notes: Option<String>,
    /// The class this one counts toward — a lab section folding into its lecture.
    #[serde(default)]
    pub parent_id: Option<i64>,
    /// The parent's category this class's percentage is filed under.
    #[serde(default)]
    pub parent_category_id: Option<i64>,
}

fn default_credits() -> f64 {
    4.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeCategory {
    /// Zero for one that does not exist yet.
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub course_id: i64,
    pub name: String,
    /// Percent of the final grade. Zero is allowed: a category can exist before its weight
    /// is known.
    #[serde(default)]
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeItem {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub course_id: i64,
    #[serde(default)]
    pub category_id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub task_id: Option<i64>,
    /// None until it is graded.
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub points: Option<f64>,
    /// `paste` or `manual`.
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "manual".to_string()
}

/// Every course with its categories and items, in one answer — the grade is meaningless
/// without all three, and three round trips is a frame where it is wrong.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradesSnapshot {
    pub courses: Vec<Course>,
    pub categories: Vec<GradeCategory>,
    pub items: Vec<GradeItem>,
}

/// Loads everything, first making sure every course the coursework feed names has a row —
/// so a class shows up on the page before anything about it has been typed.
pub fn snapshot(conn: &Connection) -> Result<GradesSnapshot> {
    conn.execute(
        "INSERT OR IGNORE INTO courses (code, created_at)
         SELECT DISTINCT course_code, ?1 FROM tasks
          WHERE course_code IS NOT NULL AND TRIM(course_code) <> '' AND dismissed_at IS NULL",
        params![chrono::Utc::now().timestamp()],
    )?;

    let courses = conn
        .prepare_cached(
            "SELECT id, code, name, credits, target_percent, notes, parent_id, parent_category_id
               FROM courses ORDER BY code",
        )?
        .query_map([], |row| {
            Ok(Course {
                id: row.get(0)?,
                code: row.get(1)?,
                name: row.get(2)?,
                credits: row.get(3)?,
                target_percent: row.get(4)?,
                notes: row.get(5)?,
                parent_id: row.get(6)?,
                parent_category_id: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let categories = conn
        .prepare_cached(
            "SELECT id, course_id, name, weight FROM grade_categories ORDER BY course_id, id",
        )?
        .query_map([], |row| {
            Ok(GradeCategory {
                id: row.get(0)?,
                course_id: row.get(1)?,
                name: row.get(2)?,
                weight: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let items = conn
        .prepare_cached(
            "SELECT id, course_id, category_id, title, task_id, score, points, source
               FROM grade_items ORDER BY course_id, id",
        )?
        .query_map([], |row| {
            Ok(GradeItem {
                id: row.get(0)?,
                course_id: row.get(1)?,
                category_id: row.get(2)?,
                title: row.get(3)?,
                task_id: row.get(4)?,
                score: row.get(5)?,
                points: row.get(6)?,
                source: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(GradesSnapshot {
        courses,
        categories,
        items,
    })
}

/// A class the feed does not know about — typed in by hand.
pub fn create_course(conn: &Connection, code: &str, name: Option<&str>) -> Result<i64> {
    let code = code.trim();
    if code.is_empty() {
        return Err(anyhow::anyhow!("a class needs a code or a name"));
    }
    conn.execute(
        "INSERT INTO courses (code, name, created_at) VALUES (?1, ?2, ?3)",
        params![code, name.map(str::trim).filter(|value| !value.is_empty()), now()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn save_course(conn: &Connection, course: &Course) -> Result<()> {
    if !(0.0..=30.0).contains(&course.credits) {
        return Err(anyhow::anyhow!("credits must be between 0 and 30"));
    }
    if let Some(parent) = course.parent_id {
        // One level only: a class cannot count toward itself, toward a class that is
        // itself linked, or be a parent while it is linked.
        let nested: bool = conn.query_row(
            "SELECT ?1 = ?2
                 OR EXISTS (SELECT 1 FROM courses WHERE id = ?2 AND parent_id IS NOT NULL)
                 OR EXISTS (SELECT 1 FROM courses WHERE parent_id = ?1)",
            params![course.id, parent],
            |row| row.get(0),
        )?;
        if nested {
            return Err(anyhow::anyhow!("a class can only count toward one class that is not itself linked"));
        }
    }
    let category = course.parent_id.and(course.parent_category_id);
    conn.execute(
        "UPDATE courses SET name = ?2, credits = ?3, target_percent = ?4, notes = ?5,
                            parent_id = ?6, parent_category_id = ?7
          WHERE id = ?1",
        params![
            course.id,
            course.name.as_deref().map(str::trim).filter(|value| !value.is_empty()),
            course.credits,
            course.target_percent,
            course.notes,
            course.parent_id,
            category,
        ],
    )?;
    Ok(())
}

/// Takes its categories and items with it. A feed course comes back empty on the next load.
pub fn delete_course(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM courses WHERE id = ?1", params![id])?;
    Ok(())
}

/// Replaces a course's categories with `categories`, keeping the ids of the ones that
/// already exist so their items stay filed under them. A category left out is deleted and
/// its items become uncategorised rather than disappearing.
pub fn save_categories(
    conn: &Connection,
    course_id: i64,
    categories: &[GradeCategory],
) -> Result<Vec<GradeCategory>> {
    let tx = conn.unchecked_transaction()?;
    let mut kept = Vec::new();

    for category in categories {
        let name = category.name.trim();
        if name.is_empty() {
            continue;
        }
        let weight = category.weight.clamp(0.0, 100.0);
        let id = if category.id > 0 {
            tx.execute(
                "UPDATE grade_categories SET name = ?3, weight = ?4
                  WHERE id = ?1 AND course_id = ?2",
                params![category.id, course_id, name, weight],
            )?;
            category.id
        } else {
            tx.execute(
                "INSERT INTO grade_categories (course_id, name, weight) VALUES (?1, ?2, ?3)",
                params![course_id, name, weight],
            )?;
            tx.last_insert_rowid()
        };
        kept.push(id);
    }

    let existing: Vec<i64> = tx
        .prepare("SELECT id FROM grade_categories WHERE course_id = ?1")?
        .query_map([course_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for id in existing.into_iter().filter(|id| !kept.contains(id)) {
        // `ON DELETE SET NULL` would do this with foreign keys on; doing it explicitly
        // means it holds on a connection that forgot to turn them on.
        tx.execute(
            "UPDATE grade_items SET category_id = NULL WHERE category_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM grade_categories WHERE id = ?1", params![id])?;
    }

    tx.commit()?;

    Ok(conn
        .prepare("SELECT id, course_id, name, weight FROM grade_categories WHERE course_id = ?1 ORDER BY id")?
        .query_map([course_id], |row| {
            Ok(GradeCategory {
                id: row.get(0)?,
                course_id: row.get(1)?,
                name: row.get(2)?,
                weight: row.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?)
}

/// Writes pasted or typed rows by title: the same assignment pasted twice is updated, not
/// added again. A row that arrives without a task link keeps the one it already had.
pub fn upsert_items(conn: &Connection, course_id: i64, items: &[GradeItem]) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut written = 0;
    for item in items {
        let title = item.title.trim();
        if title.is_empty() {
            continue;
        }
        validate(item)?;
        written += tx.execute(
            "INSERT INTO grade_items
                (course_id, category_id, title, task_id, score, points, source, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(course_id, title) DO UPDATE SET
                category_id = COALESCE(excluded.category_id, grade_items.category_id),
                task_id     = COALESCE(excluded.task_id, grade_items.task_id),
                score       = excluded.score,
                points      = COALESCE(excluded.points, grade_items.points),
                source      = excluded.source,
                updated_at  = excluded.updated_at",
            params![
                course_id,
                item.category_id,
                title,
                item.task_id,
                item.score,
                item.points,
                item.source,
                now()
            ],
        )?;
    }
    tx.commit()?;
    Ok(written)
}

/// One row edited in place — including its title, which the upsert cannot change.
pub fn update_item(conn: &Connection, item: &GradeItem) -> Result<()> {
    let title = item.title.trim();
    if title.is_empty() {
        return Err(anyhow::anyhow!("an assignment needs a name"));
    }
    validate(item)?;
    let clash: Option<i64> = conn
        .query_row(
            "SELECT id FROM grade_items WHERE course_id = ?1 AND title = ?2 AND id <> ?3",
            params![item.course_id, title, item.id],
            |row| row.get(0),
        )
        .optional()?;
    if clash.is_some() {
        return Err(anyhow::anyhow!("this class already has an assignment called that"));
    }
    conn.execute(
        "UPDATE grade_items
            SET category_id = ?2, title = ?3, score = ?4, points = ?5, updated_at = ?6
          WHERE id = ?1",
        params![item.id, item.category_id, title, item.score, item.points, now()],
    )?;
    Ok(())
}

pub fn delete_item(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM grade_items WHERE id = ?1", params![id])?;
    Ok(())
}

/// Scores may run past the points (extra credit); negative numbers are a typo.
fn validate(item: &GradeItem) -> Result<()> {
    if item.score.is_some_and(|score| score < 0.0) || item.points.is_some_and(|points| points < 0.0)
    {
        return Err(anyhow::anyhow!("scores and points cannot be negative"));
    }
    Ok(())
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrations::run_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn a_lab_links_one_level_and_unlinks_when_its_lecture_goes() {
        let conn = memory_db();
        let lecture = create_course(&conn, "PHYS 040", None).unwrap();
        let lab = create_course(&conn, "PHYS 040L", None).unwrap();
        let other = create_course(&conn, "MATH 9A", None).unwrap();
        let lab_category = save_categories(
            &conn,
            lecture,
            &[GradeCategory { id: 0, course_id: lecture, name: "Lab".into(), weight: 20.0 }],
        )
        .unwrap()[0]
            .id;

        let course = |id| snapshot(&conn).unwrap().courses.into_iter().find(|c| c.id == id).unwrap();
        let mut linked = course(lab);
        linked.parent_id = Some(lecture);
        linked.parent_category_id = Some(lab_category);
        save_course(&conn, &linked).unwrap();
        assert_eq!(course(lab).parent_category_id, Some(lab_category));

        // Not toward itself, not toward a linked class, and a parent cannot be linked.
        let mut selfish = course(other);
        selfish.parent_id = Some(other);
        assert!(save_course(&conn, &selfish).is_err());
        selfish.parent_id = Some(lab);
        assert!(save_course(&conn, &selfish).is_err());
        let mut parent = course(lecture);
        parent.parent_id = Some(other);
        assert!(save_course(&conn, &parent).is_err());

        delete_course(&conn, lecture).unwrap();
        let orphan = course(lab);
        assert_eq!((orphan.parent_id, orphan.parent_category_id), (None, None));
    }

    fn item(title: &str, score: Option<f64>, points: f64) -> GradeItem {
        GradeItem {
            id: 0,
            course_id: 0,
            category_id: None,
            title: title.to_string(),
            task_id: None,
            score,
            points: Some(points),
            source: "paste".to_string(),
        }
    }

    #[test]
    fn a_feed_course_appears_before_anything_is_typed() {
        let conn = memory_db();
        conn.execute(
            "INSERT INTO tasks (provider, external_id, title, course_code)
             VALUES ('canvas', 'a-1', 'Lab 1', 'CS 100'), ('canvas', 'a-2', 'Lab 2', 'CS 100')",
            [],
        )
        .unwrap();

        let first = snapshot(&conn).unwrap();
        assert_eq!(first.courses.len(), 1);
        assert_eq!(first.courses[0].code, "CS 100");
        assert_eq!(first.courses[0].credits, 4.0);
        // Loading again does not add a second row.
        assert_eq!(snapshot(&conn).unwrap().courses.len(), 1);
    }

    #[test]
    fn pasting_the_same_grades_twice_updates_rather_than_duplicates() {
        let conn = memory_db();
        let course = create_course(&conn, "MATH 9A", None).unwrap();

        upsert_items(&conn, course, &[item("Quiz 1", None, 10.0)]).unwrap();
        upsert_items(&conn, course, &[item("Quiz 1", Some(8.0), 10.0)]).unwrap();

        let items = snapshot(&conn).unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].score, Some(8.0));
    }

    #[test]
    fn removing_a_category_keeps_its_items_uncategorised() {
        let conn = memory_db();
        let course = create_course(&conn, "PHYS 40A", None).unwrap();
        let saved = save_categories(
            &conn,
            course,
            &[
                GradeCategory { id: 0, course_id: course, name: "Homework".into(), weight: 30.0 },
                GradeCategory { id: 0, course_id: course, name: "Exams".into(), weight: 70.0 },
            ],
        )
        .unwrap();
        let homework = saved.iter().find(|entry| entry.name == "Homework").unwrap().id;
        let exams = saved.iter().find(|entry| entry.name == "Exams").unwrap().clone();

        upsert_items(
            &conn,
            course,
            &[GradeItem { category_id: Some(homework), ..item("HW 1", Some(9.0), 10.0) }],
        )
        .unwrap();

        // Keeps Exams (by id, renamed), drops Homework.
        let after = save_categories(
            &conn,
            course,
            &[GradeCategory { name: "Exams and quizzes".into(), ..exams.clone() }],
        )
        .unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, exams.id);

        let items = snapshot(&conn).unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].category_id, None);
    }

    #[test]
    fn a_renamed_item_cannot_collide_with_another() {
        let conn = memory_db();
        let course = create_course(&conn, "ENGL 1A", None).unwrap();
        upsert_items(&conn, course, &[item("Essay 1", None, 100.0), item("Essay 2", None, 100.0)])
            .unwrap();
        let mut second = snapshot(&conn)
            .unwrap()
            .items
            .into_iter()
            .find(|entry| entry.title == "Essay 2")
            .unwrap();
        second.title = "Essay 1".into();
        assert!(update_item(&conn, &second).is_err());
    }
}
