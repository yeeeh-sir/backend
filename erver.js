[1mdiff --git a/server.js b/server.js[m
[1mindex f566061..32b148f 100644[m
[1m--- a/server.js[m
[1m+++ b/server.js[m
[36m@@ -2496,74 +2496,6 @@[m [mapp.delete([m
   }[m
 );[m
 [m
[31m-app.put([m
[31m-  '/api/comments/:id/like',[m
[31m-  async (req, res) => {[m
[31m-    try {[m
[31m-      const {[m
[31m-        id[m
[31m-      } = req.params;[m
[31m-[m
[31m-      const liked = Boolean([m
[31m-        req.body &&[m
[31m-        req.body.liked[m
[31m-      );[m
[31m-[m
[31m-      const pool =[m
[31m-        getPool();[m
[31m-[m
[31m-      const [existing] =[m
[31m-        await pool.query([m
[31m-          `[m
[31m-            SELECT id, likes[m
[31m-            FROM comments[m
[31m-            WHERE id = ?[m
[31m-          `,[m
[31m-          [id][m
[31m-        );[m
[31m-[m
[31m-      if (!existing.length) {[m
[31m-        return res.status(404).json({[m
[31m-          error:[m
[31m-            'Comment not found.'[m
[31m-        });[m
[31m-      }[m
[31m-[m
[31m-      const newLikes =[m
[31m-        Math.max([m
[31m-          0,[m
[31m-          (existing[0].likes ||[m
[31m-            0) +[m
[31m-            (liked ? 1 : -1)[m
[31m-        );[m
[31m-[m
[31m-      await pool.execute([m
[31m-        `[m
[31m-          UPDATE comments[m
[31m-          SET likes = ?[m
[31m-          WHERE id = ?[m
[31m-        `,[m
[31m-        [newLikes, id][m
[31m-      );[m
[31m-[m
[31m-      res.json({[m
[31m-        likes: newLikes[m
[31m-      });[m
[31m-[m
[31m-    } catch (error) {[m
[31m-      console.error([m
[31m-        'Toggle comment like error:',[m
[31m-        error[m
[31m-      );[m
[31m-[m
[31m-      res.status(500).json({[m
[31m-        error:[m
[31m-          'Unable to update like.'[m
[31m-      });[m
[31m-    }[m
[31m-  }[m
[31m-);[m
[31m-[m
 /* =========================================================[m
    ADVERTISEMENTS[m
 ========================================================= */[m
