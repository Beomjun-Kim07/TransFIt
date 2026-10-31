package com.yj.departure

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** Tiny SQLite store for trips. All data stays on the phone. */
class Db private constructor(ctx: Context) : SQLiteOpenHelper(ctx, "departure.db", null, 2) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE trips(" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT," +
                "start_ms INTEGER NOT NULL," +
                "end_ms INTEGER," +
                "direction TEXT NOT NULL," +
                "source TEXT NOT NULL," +
                "board_ms INTEGER," +
                "expected_sec INTEGER," +
                "walk_expected_sec INTEGER)"
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE trips ADD COLUMN board_ms INTEGER")
            db.execSQL("ALTER TABLE trips ADD COLUMN expected_sec INTEGER")
            db.execSQL("ALTER TABLE trips ADD COLUMN walk_expected_sec INTEGER")
        }
    }

    private fun Cursor.longOrNull(i: Int): Long? = if (isNull(i)) null else getLong(i)

    private fun Cursor.toTrip() = Trip(
        id = getLong(0),
        startMs = getLong(1),
        endMs = longOrNull(2),
        direction = getString(3),
        source = getString(4),
        boardMs = longOrNull(5),
        expectedSec = longOrNull(6),
        walkExpectedSec = longOrNull(7),
    )

    private val columns = arrayOf("id", "start_ms", "end_ms", "direction", "source", "board_ms", "expected_sec", "walk_expected_sec")

    private fun query(where: String?, args: Array<String>?, order: String): List<Trip> {
        val out = ArrayList<Trip>()
        readableDatabase.query("trips", columns, where, args, null, null, order).use { c ->
            while (c.moveToNext()) out.add(c.toTrip())
        }
        return out
    }

    private fun ContentValues.putLong(key: String, v: Long?) {
        if (v == null) putNull(key) else put(key, v)
    }

    fun startTrip(startMs: Long, direction: String, source: String, walkExpectedSec: Long? = null): Long {
        val v = ContentValues().apply {
            put("start_ms", startMs)
            put("direction", direction)
            put("source", source)
            putLong("walk_expected_sec", walkExpectedSec)
        }
        return writableDatabase.insert("trips", null, v)
    }

    fun insertDone(
        startMs: Long,
        endMs: Long,
        direction: String,
        source: String,
        boardMs: Long? = null,
        expectedSec: Long? = null,
        walkExpectedSec: Long? = null,
    ) {
        val v = ContentValues().apply {
            put("start_ms", startMs)
            put("end_ms", endMs)
            put("direction", direction)
            put("source", source)
            putLong("board_ms", boardMs)
            putLong("expected_sec", expectedSec)
            putLong("walk_expected_sec", walkExpectedSec)
        }
        writableDatabase.insert("trips", null, v)
    }

    fun deleteBySource(source: String) {
        writableDatabase.delete("trips", "source = ?", arrayOf(source))
    }

    fun markBoard(id: Long, boardMs: Long) {
        val v = ContentValues().apply { put("board_ms", boardMs) }
        writableDatabase.update("trips", v, "id = ?", arrayOf(id.toString()))
    }

    fun finishTrip(id: Long, endMs: Long, expectedSec: Long? = null) {
        val v = ContentValues().apply {
            put("end_ms", endMs)
            putLong("expected_sec", expectedSec)
        }
        writableDatabase.update("trips", v, "id = ?", arrayOf(id.toString()))
    }

    fun deleteTrip(id: Long) {
        writableDatabase.delete("trips", "id = ?", arrayOf(id.toString()))
    }

    fun openTrip(direction: String): Trip? =
        query("end_ms IS NULL AND direction = ?", arrayOf(direction), "start_ms DESC").firstOrNull()

    fun discardOpen(direction: String) {
        writableDatabase.delete("trips", "end_ms IS NULL AND direction = ?", arrayOf(direction))
    }

    /** Finished trips, newest first. direction == null returns both directions. */
    fun completed(direction: String? = null): List<Trip> =
        if (direction == null) query("end_ms IS NOT NULL", null, "start_ms DESC")
        else query("end_ms IS NOT NULL AND direction = ?", arrayOf(direction), "start_ms DESC")

    companion object {
        @Volatile private var instance: Db? = null
        fun get(ctx: Context): Db = instance ?: synchronized(this) {
            instance ?: Db(ctx.applicationContext).also { instance = it }
        }
    }
}
