using System;
using System.Drawing;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

namespace AgentBrowser.Installer {
    internal static class SetupDisplayTests {
        static void Check(Control parent) {
            foreach (Control control in parent.Controls) {
                if (!control.Visible) continue;
                if (control is Label && control.Text.Length > 0) {
                    var size = TextRenderer.MeasureText(control.Text, control.Font, new Size(control.ClientSize.Width, Int32.MaxValue), TextFormatFlags.WordBreak);
                    if (size.Height > control.ClientSize.Height + 2)
                        throw new Exception("Clipped label: " + control.Text + " required=" + size.Height + " actual=" + control.Height);
                }
                Check(control);
            }
        }
        // Sibling controls must not cover each other: the one added first is on top and hides the other's text.
        static readonly List<string> Overlaps = new List<string>();
        static string Describe(Control c) { return (c.Name.Length > 0 ? c.Name : c.GetType().Name) + "[" + (c.Text.Length > 24 ? c.Text.Substring(0, 24) : c.Text) + "]"; }
        static void CheckOverlap(Control parent, string where) {
            // Thin docked separator lines are decoration, not content.
            var shown = parent.Controls.Cast<Control>().Where(c => c.Visible && c.Width > 2 && c.Height > 2).ToList();
            for (int i = 0; i < shown.Count; i++) for (int j = i + 1; j < shown.Count; j++) {
                var hit = Rectangle.Intersect(shown[i].Bounds, shown[j].Bounds);
                // 1 px of tolerance for rounding when the form scales with the font.
                if (hit.Width > 1 && hit.Height > 1) Overlaps.Add(where + ": " + Describe(shown[i]) + " covers " + Describe(shown[j]) + " by " + hit.Width + "x" + hit.Height);
            }
            foreach (var child in shown) CheckOverlap(child, where);
        }
        // A button sized from the point size alone clips its caption on a scaled display.
        static void CheckButton(Control parent, string name) {
            var found = parent.Controls.Find(name, true);
            if (found.Length != 1) throw new Exception("Button missing: " + name);
            var needed = TextRenderer.MeasureText(found[0].Text, found[0].Font);
            if (found[0].Height < needed.Height || found[0].Width < needed.Width)
                throw new Exception("Clipped button: " + name + " required=" + needed + " actual=" + found[0].Size);
        }
        // The step bar is one line: every step name must fit inside it at any font size.
        static void CheckStepBar(Form form) {
            var found = form.Controls.Find("StepBar", true);
            if (found.Length != 1) throw new Exception("Step bar missing");
            foreach (Control step in found[0].Controls)
                if (step.Right > found[0].ClientSize.Width || step.Bottom > found[0].ClientSize.Height)
                    throw new Exception("Clipped step: " + step.Text + " bounds=" + step.Bounds + " bar=" + found[0].ClientSize);
            if (found[0].Controls.Count == 0) throw new Exception("Step bar is empty");
        }
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
        // The picture must be the window as Windows composes it. DrawToBitmap paints child controls in
        // another order than the screen does, so a label covering a field does not show in it.
        static void Capture(Form form, string path) {
            form.Refresh();Application.DoEvents();form.Update();
            using (var bitmap = new Bitmap(form.Width, form.Height)) {
                bool drawn;
                using (var graphics = Graphics.FromImage(bitmap)) { IntPtr dc = graphics.GetHdc(); try { drawn = PrintWindow(form.Handle, dc, 2); } finally { graphics.ReleaseHdc(dc); } }
                // Modal dialogs captured right after ShowDialog can return an uncomposited black surface with PW_RENDERFULLCONTENT(2); fall back to WM_PRINT(0).
                if (drawn && bitmap.Width > 80 && bitmap.Height > 80 && bitmap.GetPixel(bitmap.Width / 2, bitmap.Height / 2).ToArgb() == Color.Black.ToArgb()) {
                    using (var graphics = Graphics.FromImage(bitmap)) { IntPtr dc = graphics.GetHdc(); try { drawn = PrintWindow(form.Handle, dc, 0); } finally { graphics.ReleaseHdc(dc); } }
                }
                if (!drawn) { form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); Console.WriteLine("WARN capture fallback: " + path); }
                bitmap.Save(path);
            }
        }
        [STAThread] public static int Main(string[] args) {
            Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
            Directory.CreateDirectory(args[0]);
            try {
                foreach (float size in new [] {10F, 12.5F, 15F, 20F}) {
                    using (var form = new SetupForm(new [] {"--no-discover", "--no-start", "--no-startup", "--install-dir", Path.Combine(args[0], "synthetic-install")})) {
                        form.Show();Application.DoEvents();
                        form.Font = new Font("Malgun Gothic", size);
                        Application.DoEvents();
                        foreach (int page in new [] {0,1,2,3,4,5,6,7}) {
                            typeof(SetupForm).GetMethod("SetPage", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] {page});
                            Application.DoEvents();Check(form);CheckStepBar(form);CheckOverlap(form, size + "pt page " + page);
                            // At the design size every page fits: scrollbars are for small screens only.
                            if (size == 10F) {
                                var viewport = (ScrollableControl)form.Controls.Find("PageViewport", true)[0];
                                if (viewport.VerticalScroll.Visible || viewport.HorizontalScroll.Visible)
                                    throw new Exception("Page " + page + " scrolls at the default window size: viewport=" + viewport.ClientSize + " needs=" + viewport.AutoScrollMinSize);
                            }
                            Capture(form, Path.Combine(args[0], "font-" + size + "-page-" + page + ".png"));
                        }
                        // The final page with both repair actions and an error in the status line: nothing may be clipped.
                        foreach (string name in new [] {"FixChrome", "FixRuntime"}) form.Controls.Find(name, true)[0].Visible = true;
                        var checks = (ListBox)form.Controls.Find("DoneChecks", true)[0];
                        checks.Items.Clear();
                        checks.Items.Add("✓ Bridge가 실행 중입니다.");
                        checks.Items.Add("✗ Chrome 확장이 연결되지 않았습니다. [Chrome 연결 단계로]를 누르세요.");
                        checks.Items.Add("✗ 저장된 실행 환경이 없습니다. [OpenCode 설정으로]를 누르세요.");
                        typeof(SetupForm).GetMethod("MarkDone", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] {false});
                        ((Notice)form.Controls.Find("Status", true)[0]).Fail("설치된 파일이 수정되어 그대로 보존했습니다. 파일을 원래대로 되돌리거나 새 폴더에 설치하세요.\r\n(원문: An installed file was modified)");
                        Application.DoEvents();Check(form);
                        foreach (string name in new [] {"FixChrome", "FixRuntime", "Recheck"}) CheckButton(form, name);
                        Capture(form, Path.Combine(args[0], "font-" + size + "-final-actions.png"));
                        Exception dialogError=null;
                        using(var timer=new Timer{Interval=100}) {
                            timer.Tick+=delegate {
                                foreach(Form dialog in Application.OpenForms) {
                                    if(dialog==form)continue;
                                    timer.Stop();
                                    try {
                                        Check(dialog);CheckOverlap(dialog, size + "pt advanced");
                                        foreach (string name in new [] {"CancelAdvanced", "CloseAdvanced"}) {
                                            CheckButton(dialog, name);
                                            var b = dialog.Controls.Find(name, true)[0];
                                            var rect = dialog.RectangleToClient(b.RectangleToScreen(b.ClientRectangle));
                                            if (!dialog.ClientRectangle.Contains(rect)) throw new Exception("Dialog button clipped: " + name + " rect=" + rect + " client=" + dialog.ClientRectangle);
                                        }
                                        Capture(dialog, Path.Combine(args[0],"font-"+size+"-advanced.png"));
                                    }
                                    catch(Exception error){dialogError=error;}
                                    dialog.Close();break;
                                }
                            };
                            timer.Start();typeof(SetupForm).GetMethod("ShowAdvanced",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,null);
                        }
                        if(dialogError!=null)throw dialogError;
                        form.ClientSize=new Size(720,520);form.PerformLayout();Application.DoEvents();
                        var next=form.Controls.Find("Cancel",true)[0];
                        if(!next.Visible||!form.ClientRectangle.Contains(form.RectangleToClient(next.RectangleToScreen(next.ClientRectangle))))throw new Exception("Navigation clipped on a small window: client="+form.ClientRectangle+" button="+form.RectangleToClient(next.RectangleToScreen(next.ClientRectangle))+" visible="+next.Visible+" parent="+next.Parent.Bounds+" footer="+next.Parent.Parent.Bounds+" bottom="+next.Parent.Parent.Parent.Bounds);
                        form.Close();Console.WriteLine("PASS setup pages, advanced settings and small-window navigation at " + size + "pt");
                    }
                }
                if (Overlaps.Count > 0) throw new Exception("Overlapping controls:\r\n" + String.Join("\r\n", Overlaps.Distinct()));
                return 0;
            } catch(Exception error) {Console.Error.WriteLine(error.Message);return 1;}
        }
    }
}
